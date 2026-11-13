"""Runs the enabled source adapters for one run and feeds new postings into the pipeline."""

from __future__ import annotations

import asyncio
import itertools
import logging
import os
import time
from dataclasses import replace
from typing import Any

from leadscout_common.bus import Bus
from leadscout_common.config import load_yaml
from leadscout_common.retry import with_retry
from leadscout_common.schemas import (
    Agent,
    Event,
    EventType,
    JobMessage,
    JobPosting,
    RunCommand,
    Settings,
    Stream,
)
from leadscout_common.shared_state import SEEN_KEY, load_settings, mark_seen, run_stopped
from leadscout_common.text import contains_phrase

from .sources import ALL_SOURCES
from .sources.base import FetchContext, Source, SourceGaveUp, new_http_client
from .sources.common import error_text
from .sources.text import keyword_stems, title_has_stem

log = logging.getLogger(__name__)
MAX_PARALLEL_SOURCES = 4
MAX_ERROR_CHARS = 300


class Dealer:
    """Gives each posting of a run its row of the pipeline: the rows in turn, so every
    row gets the same share. One per run, shared by the sources fetched at the same time."""

    def __init__(self, rows: int) -> None:
        self._rows = max(rows, 1)
        self._turn = itertools.count()

    def next_row(self) -> int:
        return next(self._turn) % self._rows + 1


def scraped_sources_allowed() -> bool:
    return os.environ.get("ENABLE_SCRAPED_SOURCES", "false").lower() == "true"


def select_sources(command: RunCommand, settings: Settings) -> list[Source]:
    """Sources for this run: the ones the run names, else every enabled one."""
    wanted = set(command.options.sources) or {n for n, on in settings.sources.items() if on}
    chosen = [source for source in ALL_SOURCES if source.name in wanted]
    if not scraped_sources_allowed():
        chosen = [source for source in chosen if not source.scraped]
    return chosen


def rank_by_keywords(postings: list[JobPosting], keywords: list[str]) -> list[JobPosting]:
    """Best titles first, so the limit picks them: a whole keyword phrase, then a word-stem.

    Matching is by whole words, so the keyword "AI" does not promote "Email Engineer".
    The sort is stable: within a tier the source's own order is kept.
    """
    stems = keyword_stems(keywords)

    def tier(posting: JobPosting) -> int:
        if any(contains_phrase(posting.title, keyword) for keyword in keywords):
            return 0
        return 1 if title_has_stem(posting.title, stems) else 2

    return sorted(postings, key=tier)


async def execute_run(bus: Bus, command: RunCommand) -> None:
    """Fetch every selected source, publish unseen postings, then announce the scout is done.

    A source cannot abort the run: `_run_one_source` turns its failures into `source.failed`,
    and anything that still escapes (Redis down while reporting) is logged after every
    other source has finished, so the shared HTTP client is never closed under them.
    """
    settings = await load_settings(bus)
    limit = command.options.limit_per_source or settings.limit_per_source
    gate = asyncio.Semaphore(MAX_PARALLEL_SOURCES)
    dealer = Dealer(rows=command.options.workers or settings.workers)

    try:
        async with new_http_client() as http:
            shared = FetchContext(
                http=http, keywords=settings.keywords, limit=limit, redis=bus.redis
            )

            async def run_source(source: Source) -> None:
                async with gate:
                    # A stopped run fetches nothing more; sources already started finish
                    # their request and forward nothing.
                    if not await run_stopped(bus, command.run_id):
                        await _run_one_source(bus, command, source, shared, dealer)

            sources = select_sources(command, settings)
            results = await asyncio.gather(*map(run_source, sources), return_exceptions=True)
            for source, result in zip(sources, results, strict=True):
                if isinstance(result, BaseException):
                    log.error("Source %s could not report: %s", source.name, error_text(result))
    finally:
        # Always announced, even after a crash, so the run can finish instead of hanging.
        done = Event(run_id=command.run_id, agent=Agent.SCOUT, type=EventType.SCOUT_DONE)
        await bus.emit(done)


async def _run_one_source(
    bus: Bus, command: RunCommand, source: Source, shared: FetchContext, dealer: Dealer
) -> None:
    """Fetch one source and forward its new postings; any failure becomes `source.failed`.

    The source's own context is built inside the guard too, because it reads
    `config/sources.yaml`, which the owner edits by hand.
    """
    started = time.monotonic()
    try:
        await bus.emit(_source_event(command, source, EventType.SOURCE_STARTED))
        ctx = replace(shared, settings=_source_settings(source))
        postings = await with_retry(lambda: _fetch(source, ctx))
        forwarded, unsendable = await _forward_new(bus, command, postings, ctx, dealer)
    except Exception as error:
        reason = _failure_text(error)
        log.warning("Source %s failed: %s", source.name, reason)
        await bus.emit(_source_event(command, source, EventType.SOURCE_FAILED, error=reason))
        return

    finished = _source_event(
        command,
        source,
        EventType.SOURCE_FINISHED,
        count=len(postings),
        new=forwarded,
        skipped=ctx.skipped + unsendable,
    )
    finished.duration_ms = int((time.monotonic() - started) * 1000)
    await bus.emit(finished)


def _source_settings(source: Source) -> dict[str, Any]:
    """The source's section of `config/sources.yaml`, read per run so edits apply at once."""
    return load_yaml("sources.yaml").get(source.name) or {}


async def _fetch(source: Source, ctx: FetchContext) -> list[JobPosting]:
    ctx.skipped = 0  # a retried fetch counts only its own skipped records
    return await source.fetch(ctx)


async def _forward_new(
    bus: Bus, command: RunCommand, postings: list[JobPosting], ctx: FetchContext, dealer: Dealer
) -> tuple[int, int]:
    """Forward up to `ctx.limit` postings not seen before, best titles first.

    The limit counts forwarded postings, not offered ones, so postings already seen do not
    use it up and later runs reach further down the list. With `force` every posting
    counts as new, which re-sends the first `limit`. Returns (forwarded, unsendable): a
    posting whose text cannot be encoded is logged and skipped, not fatal to the source.
    """
    forwarded = unsendable = 0
    for posting in rank_by_keywords(postings, ctx.keywords):
        if forwarded >= ctx.limit or await run_stopped(bus, command.run_id):
            break
        try:
            if await _forward_if_new(bus, command, posting, dealer):
                forwarded += 1
        except ValueError as error:  # e.g. a lone surrogate from the feed's JSON
            log.warning("Skipping unsendable posting %r: %s", posting.url, error)
            unsendable += 1
    return forwarded, unsendable


async def _forward_if_new(
    bus: Bus, command: RunCommand, posting: JobPosting, dealer: Dealer
) -> bool:
    """Publish a posting to jobs.raw unless it was seen before; mark it seen only afterwards.

    Publishing first means a crash between the two steps repeats the posting on a later
    run (consumers are idempotent) instead of losing it. Two sources offering the same job
    at the same moment can both publish it, for the same reason harmlessly.
    """
    job_id = posting.job_id
    if not command.options.force and await bus.redis.sismember(SEEN_KEY, job_id):
        return False
    message = JobMessage(run_id=command.run_id, job=posting, lane=dealer.next_row())
    await bus.publish(Stream.RAW, message)
    await mark_seen(bus, job_id)
    await bus.emit(
        Event(
            run_id=command.run_id,
            agent=Agent.SCOUT,
            type=EventType.ITEM_FINISHED,
            job_id=job_id,
            title=f"{posting.title} @ {posting.company}"[:120],
            data={"forwarded": True, "source": posting.source},
        )
    )
    return True


def _source_event(command: RunCommand, source: Source, kind: EventType, **data: object) -> Event:
    return Event(
        run_id=command.run_id,
        agent=Agent.SCOUT,
        type=kind,
        title=source.label,
        data={"source": source.name, **data},
    )


def _failure_text(error: Exception) -> str:
    """The reason shown on the graph; a `SourceGaveUp` adds the error it wraps."""
    text = error_text(error)
    if isinstance(error, SourceGaveUp) and error.__cause__ is not None:
        text = f"{text}: {error_text(error.__cause__)}"
    return text[:MAX_ERROR_CHARS]
