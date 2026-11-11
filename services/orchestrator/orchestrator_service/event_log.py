"""Consumes the `events` stream: store each event, update projections, fan out to live viewers."""

from __future__ import annotations

import asyncio
import logging

from leadscout_common.bus import Bus
from leadscout_common.schemas import Agent, Event, EventType, Stream
from sqlalchemy import select
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from . import projector
from .db import EventRow, LeadRow, RunRow

log = logging.getLogger(__name__)
GROUP = Agent.ORCHESTRATOR.value
SUBSCRIBER_QUEUE_SIZE = 1000
RESTART_DELAY_S = 2
MAX_DB_RETRY_DELAY_S = 30
# Failures caused by the event itself; anything else is the database and is retried.
EVENT_DATA_ERRORS = (DataError, IntegrityError, ValueError, KeyError, TypeError)


class Broadcaster:
    """In-memory fan-out of live events to every open SSE connection."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[Event]] = set()

    def subscribe(self) -> asyncio.Queue[Event]:
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Event]) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: Event) -> None:
        for queue in self._subscribers:
            if queue.full():  # a stalled browser tab must not block the pipeline
                queue.get_nowait()
            queue.put_nowait(event)


async def supervise_consumer(
    bus: Bus, sessions: async_sessionmaker, broadcaster: Broadcaster
) -> None:
    """Keep the consumer alive: a Redis hiccup must not stop event recording for good.

    Restarting is safe: unacknowledged events are delivered again first, and recording
    is idempotent.
    """
    while True:
        try:
            await consume_events(bus, sessions, broadcaster)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Event consumer crashed; restarting in %ss", RESTART_DELAY_S)
            await asyncio.sleep(RESTART_DELAY_S)


async def consume_events(bus: Bus, sessions: async_sessionmaker, broadcaster: Broadcaster) -> None:
    async for message_id, event in bus.consume(Stream.EVENTS, GROUP, Event):
        run_completed = await store(sessions, event)
        if run_completed is not None:
            broadcaster.publish(event)
        if run_completed:
            await bus.emit(
                Event(run_id=event.run_id, agent=Agent.ORCHESTRATOR, type=EventType.RUN_FINISHED)
            )
        await bus.ack(Stream.EVENTS, GROUP, message_id)


async def store(sessions: async_sessionmaker, event: Event) -> bool | None:
    """Record one event, waiting out database trouble. None means the event was unusable.

    A lost event would corrupt leads and runs for good, so every failure is retried with
    back-off (Postgres restarting, out of connections, a schema not yet upgraded), except
    the ones that come from the event's own data: those fail the same way every time, so
    the event is logged and skipped.
    """
    delay = 1.0
    while True:
        try:
            async with sessions() as session:
                run_completed = await record_event(session, event)
                await session.commit()
                return run_completed
        except EVENT_DATA_ERRORS:
            log.exception("Skipping event %s (%s) that cannot be stored", event.id, event.type)
            return None
        except Exception as error:
            log.warning("Could not store event %s (%s); retrying in %.0fs", event.id, error, delay)
        await asyncio.sleep(delay)
        delay = min(delay * 2, MAX_DB_RETRY_DELAY_S)


async def record_event(session: AsyncSession, event: Event) -> bool:
    """Persist one event and apply it to its run and lead. Returns True if it completed the run.

    Safe to call twice with the same event: a redelivered event is skipped.
    """
    already_stored = await session.scalar(select(EventRow.seq).where(EventRow.id == event.id))
    if already_stored is not None:
        return False
    session.add(
        EventRow(
            **event.model_dump(exclude={"agent", "type"}),
            agent=event.agent.value,
            type=event.type.value,
            ends_job=projector.ends_job(event),
        )
    )
    await session.flush()  # run statistics are counted from the stored events

    run_completed = False
    if event.run_id and (run := await session.get(RunRow, event.run_id)):
        run_completed = await projector.update_run(session, run, event)

    if event.job_id:
        lead = await session.get(LeadRow, event.job_id)
        if lead is None and projector.creates_lead(event):
            session.add(projector.new_lead(event))
        elif lead is not None:
            projector.apply_to_lead(lead, event)
    return run_completed
