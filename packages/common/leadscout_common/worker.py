"""The loop every pipeline agent shares: read one job, handle it, report, pass it on.

A service supplies only a `handle(message)` coroutine that returns a `StageResult`;
events, timing, retries, forwarding and acknowledgement happen here, the same way for all.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .bus import Bus
from .retry import is_unreachable, with_retry
from .schemas import Agent, Event, EventType, JobMessage, Stream
from .tracing import job_context

log = logging.getLogger(__name__)
FIRST_WAIT_S = 5.0
MAX_WAIT_S = 60.0


@dataclass
class StageResult:
    """What a stage decided about one job.

    forward=True  -> publish `message` to the next stream
    forward=False -> the job ends here; `drop_reason` set means it was filtered out,
                     empty means the pipeline is complete for it
    """

    message: JobMessage
    forward: bool = True
    drop_reason: str = ""
    data: dict[str, Any] = field(default_factory=dict)


Handler = Callable[[JobMessage], Awaitable[StageResult]]


def job_label(message: JobMessage) -> str:
    return f"{message.job.title} @ {message.job.company}"[:120]


async def run_stage(
    agent: Agent,
    source: Stream,
    target: Stream | None,
    handle: Handler,
    bus: Bus | None = None,
    attempts: int = 3,
) -> None:
    """Consume `source` forever, running `handle` on each job.

    `attempts` bounds retries of transient errors. Use 1 for a handler that is long and
    retries its own steps (the researcher), so one error does not repeat the whole job.
    """
    bus = bus or Bus()
    log.info("%s listening on %s", agent.value, source.value)
    async for message_id, message in bus.consume(source, group=agent.value, model=JobMessage):
        await process_one(agent, target, handle, bus, message, attempts)
        await bus.ack(source, agent.value, message_id)


async def process_one(
    agent: Agent,
    target: Stream | None,
    handle: Handler,
    bus: Bus,
    message: JobMessage,
    attempts: int = 3,
) -> None:
    """Handle one job and emit its events. A failure becomes an `item.failed` event.

    When the model server cannot be reached at all, the job is not failed: the worker
    waits and tries the same job again, so an Ollama restart does not lose a queue of jobs.
    """

    def event(kind: EventType, **extra: Any) -> Event:
        return Event(
            run_id=message.run_id,
            agent=agent,
            type=kind,
            job_id=message.job_id,
            title=job_label(message),
            **extra,
        )

    await bus.emit(event(EventType.ITEM_STARTED))
    started = time.monotonic()
    wait = FIRST_WAIT_S
    while True:
        try:
            with job_context(agent, message):
                result = await with_retry(lambda: handle(message), attempts=attempts)
            break
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if is_unreachable(error):
                log.warning("%s: server unreachable (%s); waiting %.0fs", agent.value, error, wait)
                await asyncio.sleep(wait)
                wait = min(wait * 2, MAX_WAIT_S)
                continue
            log.exception("%s failed on %s", agent.value, job_label(message))
            failed = event(EventType.ITEM_FAILED, duration_ms=_elapsed_ms(started))
            failed.data = {"error": str(error)[:500]}
            await bus.emit(failed)
            return

    duration = _elapsed_ms(started)
    if result.drop_reason:
        await bus.emit(
            event(
                EventType.ITEM_DROPPED,
                duration_ms=duration,
                data={"reason": result.drop_reason, **result.data},
            )
        )
        return

    forwarded = result.forward and target is not None
    if forwarded:
        await bus.publish(target, result.message)
    await bus.emit(
        event(
            EventType.ITEM_FINISHED,
            duration_ms=duration,
            data={"forwarded": forwarded, **result.data},
        )
    )


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
