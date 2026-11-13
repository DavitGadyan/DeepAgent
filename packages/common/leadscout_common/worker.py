"""The loop every pipeline agent shares: read a job, handle it, report, pass it on.

A service supplies only a `handle(message)` coroutine that returns a `StageResult`;
events, timing, retries, forwarding and acknowledgement happen here, the same way for all.

Each agent has one worker per row of the pipeline. A job carries its row (`lane`): the
scout deals the jobs of a run to the rows in turn, and in every agent the job is handled
by the worker of its row, after the jobs that came to that row before it. Rows never
exchange jobs.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from .bus import Bus
from .retry import is_unreachable, with_retry
from .schemas import MAX_WORKERS, Agent, Event, EventType, JobMessage, Stream
from .shared_state import load_settings, run_stopped
from .tracing import job_context

log = logging.getLogger(__name__)
FIRST_WAIT_S = 5.0
MAX_WAIT_S = 60.0
# How often the agent looks at the row count the user chose, and at stopped runs.
WORKERS_REFRESH_S = 2.0
# Jobs read from Redis and waiting in memory for the worker of their row. They stay
# unacknowledged there, so a crash redelivers them.
MAX_WAITING = 5000
STOPPED_REASON = "The run was stopped"


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


@dataclass(frozen=True)
class _Job:
    """The job the current task is handling; lets a handler report progress."""

    bus: Bus
    agent: Agent
    message: JobMessage
    worker: int


_current_job: ContextVar[_Job | None] = ContextVar("leadscout_job", default=None)


async def report_progress(node: str, resumed: bool = False) -> None:
    """Tell the UI which node of the agent's graph the current job entered.

    A no-op outside `process_one` (unit tests, evals).
    """
    job = _current_job.get()
    if job is None:
        return
    data: dict[str, Any] = {"node": node, "worker": job.worker}
    if resumed:
        data["resumed"] = True
    await job.bus.emit(
        Event(
            run_id=job.message.run_id,
            agent=job.agent,
            type=EventType.ITEM_PROGRESS,
            job_id=job.message.job_id,
            title=job_label(job.message),
            data=data,
        )
    )


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
    """Consume `source` forever: every job goes to the worker of its row.

    A job is acknowledged when it is done, so a crash redelivers the jobs that were in
    progress or waiting. A job of a run the user stopped is let go, also in mid-work.

    `attempts` bounds retries of transient errors. Use 1 for a handler that is long and
    retries its own steps (the researcher), so one error does not repeat the whole job.
    """
    bus = bus or Bus()
    rows = _Rows(agent, source, target, handle, bus, attempts)
    log.info("%s listening on %s", agent.value, source.value)
    try:
        async for message_id, message in bus.consume(source, group=agent.value, model=JobMessage):
            await rows.give(message_id, message)
    except asyncio.CancelledError:
        if rows.failure is not None:  # a worker hit an unexpected error and stopped the reader
            raise rows.failure from None
        raise
    finally:
        await rows.stop()


class _Rows:
    """The workers of one agent, one per row, each with the queue of its row."""

    def __init__(
        self,
        agent: Agent,
        source: Stream,
        target: Stream | None,
        handle: Handler,
        bus: Bus,
        attempts: int,
    ) -> None:
        self._agent, self._source, self._target = agent, source, target
        self._handle, self._bus, self._attempts = handle, bus, attempts
        self._queues: dict[int, asyncio.Queue[tuple[str, JobMessage]]] = {}
        self._workers: dict[int, asyncio.Task[None]] = {}
        # row -> (run id, task) of the job its worker is handling right now.
        self._current: dict[int, tuple[str, asyncio.Task[None]]] = {}
        self._let_go: set[int] = set()
        self._room = asyncio.Semaphore(MAX_WAITING)
        self._reader = asyncio.current_task()
        self._watcher = asyncio.create_task(self._watch_stopped_runs())
        self._dealt = 0
        self._row_count = 1
        self._row_count_read_at = -WORKERS_REFRESH_S
        self.failure: BaseException | None = None

    async def give(self, message_id: str, message: JobMessage) -> None:
        """Queue a job for the worker of its row; that worker starts with the first job."""
        row = message.lane if 1 <= message.lane <= MAX_WORKERS else await self._deal()
        await self._room.acquire()
        if row not in self._queues:
            self._queues[row] = asyncio.Queue()
            self._workers[row] = asyncio.create_task(self._work(row))
        self._queues[row].put_nowait((message_id, message))

    async def stop(self) -> None:
        tasks = [self._watcher, *self._workers.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _deal(self) -> int:
        """A row for a job that has none (queued by an older version): the rows in turn."""
        self._dealt += 1
        return (self._dealt - 1) % await self._rows_now() + 1

    async def _rows_now(self) -> int:
        now = time.monotonic()
        if now - self._row_count_read_at >= WORKERS_REFRESH_S:
            try:
                self._row_count = (await load_settings(self._bus)).workers
            except Exception as error:  # Redis hiccup: keep the last known count
                log.warning("%s: could not read the row count (%s)", self._agent.value, error)
            self._row_count_read_at = now
        return self._row_count

    async def _work(self, row: int) -> None:
        """The worker of one row: its jobs, one after the other, for as long as the agent runs.

        An unexpected error stops the whole agent, as it did when jobs ran one at a time:
        the container restarts and Redis redelivers the jobs.
        """
        queue = self._queues[row]
        try:
            while True:
                message_id, message = await queue.get()
                self._room.release()
                await self._do(row, message_id, message)
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            self.failure = error
            if self._reader is not None:
                self._reader.cancel()

    async def _do(self, row: int, message_id: str, message: JobMessage) -> None:
        if await run_stopped(self._bus, message.run_id):
            await self._report_let_go(row, message)
        else:
            job = asyncio.create_task(
                process_one(
                    self._agent, self._target, self._handle, self._bus, message, self._attempts, row
                )
            )
            self._current[row] = (message.run_id, job)
            try:
                await job
            except asyncio.CancelledError:
                if row not in self._let_go:  # the agent itself is shutting down
                    job.cancel()
                    raise
                await self._report_let_go(row, message)
            finally:
                self._current.pop(row, None)
                self._let_go.discard(row)
        await self._bus.ack(self._source, self._agent.value, message_id)

    async def _report_let_go(self, row: int, message: JobMessage) -> None:
        await self._bus.emit(
            Event(
                run_id=message.run_id,
                agent=self._agent,
                type=EventType.ITEM_DROPPED,
                job_id=message.job_id,
                title=job_label(message),
                data={"reason": STOPPED_REASON, "stopped": True, "worker": row},
            )
        )

    async def _watch_stopped_runs(self) -> None:
        """Cut off the jobs in progress of a run the user stopped."""
        while True:
            await asyncio.sleep(WORKERS_REFRESH_S)
            for row, (run_id, job) in list(self._current.items()):
                try:
                    stopped = await run_stopped(self._bus, run_id)
                except Exception as error:  # Redis hiccup: look again next time
                    log.warning("%s: could not read stopped runs (%s)", self._agent.value, error)
                    break
                if stopped and row not in self._let_go:
                    self._let_go.add(row)
                    job.cancel()


async def process_one(
    agent: Agent,
    target: Stream | None,
    handle: Handler,
    bus: Bus,
    message: JobMessage,
    attempts: int = 3,
    worker: int = 1,
) -> None:
    """Handle one job and emit its events. A failure becomes an `item.failed` event.

    `worker` is the row of the job (the number of the worker); every event carries it.

    When the model server cannot be reached at all, the job is not failed: the worker
    waits and tries the same job again, so an Ollama restart does not lose a queue of jobs.
    """

    def event(kind: EventType, data: dict[str, Any] | None = None, **extra: Any) -> Event:
        return Event(
            run_id=message.run_id,
            agent=agent,
            type=kind,
            job_id=message.job_id,
            title=job_label(message),
            data={**(data or {}), "worker": worker},
            **extra,
        )

    _current_job.set(_Job(bus, agent, message, worker))
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
            await bus.emit(
                event(
                    EventType.ITEM_FAILED,
                    {"error": str(error)[:500]},
                    duration_ms=_elapsed_ms(started),
                )
            )
            return

    duration = _elapsed_ms(started)
    if result.drop_reason:
        await bus.emit(
            event(
                EventType.ITEM_DROPPED,
                {"reason": result.drop_reason, **result.data},
                duration_ms=duration,
            )
        )
        return

    forwarded = result.forward and target is not None
    if forwarded:
        result.message.lane = worker
        await bus.publish(target, result.message)
    await bus.emit(
        event(
            EventType.ITEM_FINISHED,
            {"forwarded": forwarded, **result.data},
            duration_ms=duration,
        )
    )


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
