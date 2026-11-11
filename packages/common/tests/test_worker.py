"""The shared stage loop: events emitted and forwarding for each kind of outcome."""

from leadscout_common.bus import PAYLOAD_FIELD, Bus
from leadscout_common.schemas import Agent, Event, EventType, JobMessage, JobPosting, Stream
from leadscout_common.worker import StageResult, process_one

JOB = JobPosting(source="test", url="https://example.com/1", title="ML Engineer", company="Acme")


def message() -> JobMessage:
    return JobMessage(run_id="run1", job=JOB)


async def events(bus: Bus) -> list[Event]:
    entries = await bus.redis.xrange(Stream.EVENTS.value)
    return [Event.model_validate_json(fields[PAYLOAD_FIELD]) for _, fields in entries]


async def test_finished_job_is_forwarded(bus: Bus) -> None:
    async def handle(msg: JobMessage) -> StageResult:
        return StageResult(msg, data={"note": "ok"})

    await process_one(Agent.EXTRACTOR, Stream.EXTRACTED, handle, bus, message())

    started, finished = await events(bus)
    assert started.type == EventType.ITEM_STARTED
    assert finished.type == EventType.ITEM_FINISHED
    assert finished.data == {"forwarded": True, "note": "ok"}
    assert finished.title == "ML Engineer @ Acme"
    assert await bus.redis.xlen(Stream.EXTRACTED.value) == 1


async def test_dropped_job_is_not_forwarded(bus: Bus) -> None:
    async def handle(msg: JobMessage) -> StageResult:
        return StageResult(msg, drop_reason="not a target role")

    await process_one(Agent.FILTER, Stream.FILTERED, handle, bus, message())

    assert (await events(bus))[-1].type == EventType.ITEM_DROPPED
    assert await bus.redis.xlen(Stream.FILTERED.value) == 0


async def test_last_stage_finishes_without_forwarding(bus: Bus) -> None:
    async def handle(msg: JobMessage) -> StageResult:
        return StageResult(msg, forward=False)

    await process_one(Agent.RESEARCHER, None, handle, bus, message())

    assert (await events(bus))[-1].data["forwarded"] is False


async def test_error_becomes_failed_event(bus: Bus) -> None:
    async def handle(msg: JobMessage) -> StageResult:
        raise ValueError("model returned nonsense")

    await process_one(Agent.SCORER, Stream.SCORED, handle, bus, message())

    failed = (await events(bus))[-1]
    assert failed.type == EventType.ITEM_FAILED
    assert "nonsense" in failed.data["error"]


def test_job_id_is_stable_across_sources() -> None:
    same_job_elsewhere = JOB.model_copy(
        update={"source": "other", "url": "https://other.example/9"}
    )
    assert same_job_elsewhere.job_id == JOB.job_id
    assert JOB.model_copy(update={"title": "Data Scientist"}).job_id != JOB.job_id


async def test_unreachable_server_is_waited_out_instead_of_failing_the_job(
    bus: Bus, monkeypatch
) -> None:
    from leadscout_common import worker

    monkeypatch.setattr(worker, "FIRST_WAIT_S", 0)
    calls = 0

    async def handle(msg: JobMessage) -> StageResult:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ConnectionError("Failed to connect to Ollama")
        return StageResult(msg)

    # attempts=1: the error must reach the wait loop, not be absorbed by the retries.
    await process_one(Agent.EXTRACTOR, Stream.EXTRACTED, handle, bus, message(), attempts=1)

    assert calls == 3
    assert [e.type for e in await events(bus)] == [EventType.ITEM_STARTED, EventType.ITEM_FINISHED]


async def test_attempts_one_does_not_retry_transient_errors(bus: Bus) -> None:
    calls = 0

    async def handle(msg: JobMessage) -> StageResult:
        nonlocal calls
        calls += 1
        raise TimeoutError("search timed out")

    await process_one(Agent.RESEARCHER, None, handle, bus, message(), attempts=1)

    assert calls == 1
    assert (await events(bus))[-1].type == EventType.ITEM_FAILED


async def test_an_entry_without_payload_is_skipped(bus: Bus) -> None:
    await bus.redis.xadd(Stream.RAW.value, {"other": "x"})
    await bus.publish(Stream.RAW, message())

    received = []
    async for _, msg in bus.consume(Stream.RAW, "g", JobMessage, block_ms=10):
        received.append(msg)
        break

    assert received[0].job.title == "ML Engineer"
