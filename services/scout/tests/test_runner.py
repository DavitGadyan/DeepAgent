"""Scout runner: which sources run, which postings are forwarded, how failures are contained."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import httpx
import pytest
from leadscout_common.bus import Bus
from leadscout_common.schemas import (
    Event,
    EventType,
    JobMessage,
    JobPosting,
    RunCommand,
    RunOptions,
    Settings,
    Stream,
)
from leadscout_common.shared_state import SEEN_KEY
from scout_service import runner
from scout_service.runner import execute_run, rank_by_keywords, select_sources
from scout_service.sources.base import FetchContext, SourceGaveUp


def posting(title: str, company: str = "Acme") -> JobPosting:
    return JobPosting(
        source="test", url=f"https://example.com/{title}", title=title, company=company
    )


@dataclass
class FakeSource:
    """A source whose fetch returns fixed postings or raises; it records each call."""

    name: str
    postings: list[JobPosting] = field(default_factory=list)
    error: Exception | None = None
    pause_s: float = 0.0
    label: str = "Fake"
    scraped: bool = False
    calls: int = 0
    client_open_after_pause: bool | None = None

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        self.calls += 1
        await asyncio.sleep(self.pause_s)
        self.client_open_after_pause = not ctx.http.is_closed
        if self.error:
            raise self.error
        return list(self.postings)


@pytest.fixture
def bus(redis) -> Bus:
    return Bus(redis)


@pytest.fixture
def use_sources(monkeypatch):
    """Run the given fake sources instead of the registry, with empty settings sections."""
    monkeypatch.setattr(runner, "load_yaml", lambda name: {})

    def install(*sources: FakeSource) -> None:
        monkeypatch.setattr(runner, "select_sources", lambda command, settings: list(sources))

    return install


async def events(bus: Bus) -> list[Event]:
    entries = await bus.redis.xrange(Stream.EVENTS.value)
    return [Event.model_validate_json(fields["json"]) for _, fields in entries]


async def raw_titles(bus: Bus) -> list[str]:
    entries = await bus.redis.xrange(Stream.RAW.value)
    return [JobMessage.model_validate_json(fields["json"]).job.title for _, fields in entries]


async def source_events(bus: Bus, kind: EventType) -> dict[str, dict]:
    return {event.data["source"]: event.data for event in await events(bus) if event.type == kind}


def run(limit: int, force: bool = False) -> RunCommand:
    return RunCommand(run_id="r1", options=RunOptions(limit_per_source=limit, force=force))


def test_keyword_titles_come_first_and_match_whole_words() -> None:
    postings = [posting("Email Engineer"), posting("Office Manager"), posting("Senior AI Engineer")]

    ranked = rank_by_keywords(postings, ["AI", "AI Engineer"])

    assert [p.title for p in ranked] == ["Senior AI Engineer", "Email Engineer", "Office Manager"]


def test_shipped_short_keyword_does_not_promote_substrings() -> None:
    postings = [posting("Email Engineer"), posting("Supply Chain Analyst"), posting("Head of AI")]

    ranked = rank_by_keywords(postings, ["AI"])

    assert ranked[0].title == "Head of AI"


def test_run_uses_enabled_sources_and_skips_scraped_ones(monkeypatch) -> None:
    monkeypatch.delenv("ENABLE_SCRAPED_SOURCES", raising=False)
    settings = Settings(sources={"jobicy": True, "remoteok": False, "linkedin": True})

    chosen = select_sources(RunCommand(run_id="r1"), settings)

    assert [source.name for source in chosen] == ["jobicy"]


def test_run_can_name_its_sources(monkeypatch) -> None:
    monkeypatch.setenv("ENABLE_SCRAPED_SOURCES", "true")
    command = RunCommand(run_id="r1", options=RunOptions(sources=["linkedin"]))

    assert [source.name for source in select_sources(command, Settings())] == ["linkedin"]


async def test_limit_counts_new_postings_so_later_runs_reach_further(bus, use_sources) -> None:
    use_sources(FakeSource("board", [posting("A"), posting("B"), posting("C")]))

    await execute_run(bus, run(limit=2))
    await execute_run(bus, run(limit=2))

    assert await raw_titles(bus) == ["A", "B", "C"]
    finished = [e.data for e in await events(bus) if e.type == EventType.SOURCE_FINISHED]
    assert [(data["count"], data["new"]) for data in finished] == [(3, 2), (3, 1)]


async def test_force_resends_the_first_limit_postings(bus, use_sources) -> None:
    use_sources(FakeSource("board", [posting("A"), posting("B"), posting("C")]))

    await execute_run(bus, run(limit=2))
    await execute_run(bus, run(limit=2, force=True))

    assert await raw_titles(bus) == ["A", "B", "A", "B"]


async def test_one_failing_source_does_not_stop_the_others(bus, use_sources, monkeypatch) -> None:
    def load_yaml(name: str) -> dict:
        raise ValueError("sources.yaml: bad indentation")

    slow = FakeSource("slow", [posting("Slow AI Engineer")], pause_s=0.05)
    use_sources(FakeSource("broken"), slow)
    monkeypatch.setattr(runner, "load_yaml", load_yaml)

    await execute_run(bus, run(limit=5))

    failed = await source_events(bus, EventType.SOURCE_FAILED)
    assert set(failed) == {"broken", "slow"}  # both read the broken file; both report it
    assert failed["broken"]["error"] == "sources.yaml: bad indentation"
    assert (await events(bus))[-1].type == EventType.SCOUT_DONE


async def test_the_shared_client_outlives_a_failing_source(bus, use_sources) -> None:
    slow = FakeSource("slow", [posting("AI Engineer")], pause_s=0.05)
    not_a_posting = FakeSource("broken", [None])  # type: ignore[list-item]  # breaks ranking
    use_sources(not_a_posting, slow)

    await execute_run(bus, run(limit=5))

    assert slow.client_open_after_pause is True
    assert set(await source_events(bus, EventType.SOURCE_FINISHED)) == {"slow"}
    assert await raw_titles(bus) == ["AI Engineer"]


async def test_an_unsendable_posting_is_skipped_and_counted(bus, use_sources) -> None:
    lone_surrogate = posting("Bad \ud83d title")
    use_sources(FakeSource("board", [lone_surrogate, posting("Good")]))

    await execute_run(bus, run(limit=5))

    assert await raw_titles(bus) == ["Good"]
    finished = (await source_events(bus, EventType.SOURCE_FINISHED))["board"]
    assert (finished["new"], finished["skipped"]) == (1, 1)


async def test_a_posting_is_marked_seen_only_after_it_was_published(bus, use_sources) -> None:
    use_sources(FakeSource("board", [posting("A")]))
    real_publish = bus.publish

    async def failing_publish(stream: Stream, message: JobMessage) -> None:
        raise ConnectionError("Redis reset the connection")

    bus.publish = failing_publish  # type: ignore[method-assign]
    await execute_run(bus, run(limit=5))
    assert await bus.redis.scard(SEEN_KEY) == 0

    bus.publish = real_publish  # type: ignore[method-assign]
    await execute_run(bus, run(limit=5))
    assert await raw_titles(bus) == ["A"]  # not lost: the next run forwards it


async def test_a_source_that_gives_up_is_not_retried(bus, use_sources) -> None:
    error = SourceGaveUp("Fake: no search query succeeded")
    error.__cause__ = httpx.ReadTimeout("")
    source = FakeSource("search", error=error)
    use_sources(source)

    await execute_run(bus, run(limit=5))

    assert source.calls == 1
    failed = (await source_events(bus, EventType.SOURCE_FAILED))["search"]
    assert failed["error"] == "Fake: no search query succeeded: ReadTimeout"


# --- Rows and stopping ---------------------------------------------------------------


async def raw_lanes(bus: Bus) -> list[int]:
    entries = await bus.redis.xrange(Stream.RAW.value)
    return [JobMessage.model_validate_json(fields["json"]).lane for _, fields in entries]


async def test_postings_are_dealt_to_the_rows_in_turn(bus, use_sources) -> None:
    from leadscout_common.schemas import RunOptions

    use_sources(FakeSource("board", [posting(title) for title in "ABCDE"]))

    await execute_run(bus, RunCommand(run_id="r1", options=RunOptions(workers=2)))

    assert await raw_lanes(bus) == [1, 2, 1, 2, 1]  # every row gets the same share


async def test_a_stopped_run_forwards_nothing_more(bus, use_sources) -> None:
    from leadscout_common.shared_state import stop_run

    source = FakeSource("board", [posting("A"), posting("B")])
    use_sources(source)
    await stop_run(bus, "r1")

    await execute_run(bus, run(limit=5))

    assert source.calls == 0  # not even fetched
    assert await raw_titles(bus) == []
    assert (await events(bus))[-1].type == EventType.SCOUT_DONE  # the run can still end
