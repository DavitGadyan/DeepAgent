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
    assert finished.data == {"forwarded": True, "note": "ok", "worker": 1}
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


# --- The worker pool ---------------------------------------------------------------


class PollingBus(Bus):
    """The fake Redis deadlocks when a command arrives during a blocking read, which a
    pool does all the time. This reads without blocking and polls instead."""

    async def consume(self, stream, group, model, consumer="c1", block_ms=None):
        import asyncio

        await self._ensure_group(stream, group)
        while True:
            batches = await self.redis.xreadgroup(group, consumer, {stream.value: ">"}, count=1)
            if not batches:
                await asyncio.sleep(0.005)
                continue
            for message_id, fields in batches[0][1]:
                yield message_id, model.model_validate_json(fields[PAYLOAD_FIELD])


async def _run_pool(bus: Bus, jobs: int, workers: int, monkeypatch) -> tuple[int, list[Event]]:
    """Run `jobs` postings through a pool and return (most at the same time, events)."""
    import asyncio

    from leadscout_common import worker
    from leadscout_common.schemas import Settings
    from leadscout_common.shared_state import save_settings

    monkeypatch.setattr(worker, "WORKERS_REFRESH_S", 0.01)
    bus = PollingBus(bus.redis)
    await save_settings(bus, Settings(workers=workers))
    for number in range(jobs):
        posting = JOB.model_copy(update={"title": f"ML Engineer {number}"})
        await bus.publish(Stream.RAW, JobMessage(run_id="run1", job=posting))
    running = most = 0
    done = asyncio.Event()

    async def handle(msg: JobMessage) -> StageResult:
        nonlocal running, most
        running += 1
        most = max(most, running)
        await asyncio.sleep(0.02)
        running -= 1
        return StageResult(msg)

    async def stop_when_done() -> None:
        while await bus.redis.xlen(Stream.FILTERED.value) < jobs:
            await asyncio.sleep(0.01)
        done.set()

    stage = asyncio.create_task(
        worker.run_stage(Agent.FILTER, Stream.RAW, Stream.FILTERED, handle, bus)
    )
    await asyncio.wait_for(stop_when_done(), timeout=5)
    await asyncio.sleep(0.05)  # let the last acknowledgements land
    stage.cancel()
    await asyncio.gather(stage, return_exceptions=True)
    return most, await events(bus)


async def test_pool_runs_as_many_jobs_at_once_as_there_are_workers(bus: Bus, monkeypatch) -> None:
    most, seen = await _run_pool(bus, jobs=6, workers=3, monkeypatch=monkeypatch)

    assert most == 3
    assert {event.data["worker"] for event in seen} == {1, 2, 3}
    pending = await bus.redis.xpending(Stream.RAW.value, Agent.FILTER.value)
    assert pending["pending"] == 0  # every job acknowledged once it finished


async def test_one_worker_handles_jobs_one_at_a_time(bus: Bus, monkeypatch) -> None:
    most, seen = await _run_pool(bus, jobs=3, workers=1, monkeypatch=monkeypatch)

    assert most == 1
    assert {event.data["worker"] for event in seen} == {1}


async def test_a_handler_can_report_the_graph_node_it_entered(bus: Bus) -> None:
    from leadscout_common.worker import report_progress

    async def handle(msg: JobMessage) -> StageResult:
        await report_progress("facts")
        await report_progress("highlights", resumed=True)
        return StageResult(msg)

    await process_one(Agent.EXTRACTOR, Stream.EXTRACTED, handle, bus, message(), worker=2)

    progress = [event for event in await events(bus) if event.type == EventType.ITEM_PROGRESS]
    assert [event.data for event in progress] == [
        {"node": "facts", "worker": 2},
        {"node": "highlights", "worker": 2, "resumed": True},
    ]
    await report_progress("outside a job")  # no job in progress: nothing happens


async def test_jobs_left_by_a_crash_are_each_delivered_once_before_any_is_acknowledged(
    bus: Bus,
) -> None:
    """A pool hands a redelivered job to a worker and asks for the next one at once."""
    for number in range(3):
        posting = JOB.model_copy(update={"title": f"ML Engineer {number}"})
        await bus.publish(Stream.RAW, JobMessage(run_id="run1", job=posting))
    first_life = bus.consume(Stream.RAW, "filter", JobMessage)
    for _ in range(3):
        await anext(first_life)  # delivered, never acknowledged: the agent "crashed"

    second_life = bus.consume(Stream.RAW, "filter", JobMessage)
    redelivered = [(await anext(second_life))[1].job.title for _ in range(3)]

    assert redelivered == ["ML Engineer 0", "ML Engineer 1", "ML Engineer 2"]


async def test_a_short_redis_outage_does_not_lose_a_write(bus: Bus, monkeypatch) -> None:
    import redis.asyncio as redis
    from leadscout_common import bus as bus_module

    monkeypatch.setattr(bus_module, "RECONNECT_DELAY_S", 0)
    real_xadd = bus.redis.xadd
    failures = [redis.TimeoutError("Timeout connecting to server")]

    async def flaky_xadd(*args, **kwargs):
        if failures:
            raise failures.pop()
        return await real_xadd(*args, **kwargs)

    monkeypatch.setattr(bus.redis, "xadd", flaky_xadd)

    await bus.emit(Event(agent=Agent.FILTER, type=EventType.ITEM_STARTED, job_id="j1"))

    assert len(await events(bus)) == 1


# --- Rows: a job never leaves its row; a stopped run lets go of its jobs -------------


async def _start_stage(bus: Bus, handle, monkeypatch, rows: int = 3):
    """A filter stage on a polling bus; returns (bus, task)."""
    import asyncio

    from leadscout_common import worker
    from leadscout_common.schemas import Settings
    from leadscout_common.shared_state import save_settings

    monkeypatch.setattr(worker, "WORKERS_REFRESH_S", 0.01)
    polling = PollingBus(bus.redis)
    await save_settings(polling, Settings(workers=rows))
    stage = asyncio.create_task(
        worker.run_stage(Agent.FILTER, Stream.RAW, Stream.FILTERED, handle, polling)
    )
    return polling, stage


async def _until(condition, timeout: float = 5.0) -> None:
    import asyncio

    async def poll() -> None:
        while not await condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


async def _end(stage) -> None:
    import asyncio

    stage.cancel()
    await asyncio.gather(stage, return_exceptions=True)


def _job(number: int, lane: int, run_id: str = "run1") -> JobMessage:
    posting = JOB.model_copy(update={"title": f"ML Engineer {number}"})
    return JobMessage(run_id=run_id, job=posting, lane=lane)


async def test_jobs_of_one_row_are_handled_by_that_row_one_after_the_other(
    bus: Bus, monkeypatch
) -> None:
    import asyncio

    running = most = 0

    async def handle(msg: JobMessage) -> StageResult:
        nonlocal running, most
        running += 1
        most = max(most, running)
        await asyncio.sleep(0.02)
        running -= 1
        return StageResult(msg)

    for number in range(4):
        await bus.publish(Stream.RAW, _job(number, lane=2))
    polling, stage = await _start_stage(bus, handle, monkeypatch, rows=3)

    async def all_forwarded() -> bool:
        return await bus.redis.xlen(Stream.FILTERED.value) == 4

    await _until(all_forwarded)
    await _end(stage)

    # Rows 1 and 3 were free the whole time; the jobs still waited for their own row.
    assert most == 1
    seen = await events(polling)
    assert {event.data["worker"] for event in seen} == {2}
    started = [event.title for event in seen if event.type == EventType.ITEM_STARTED]
    assert started == [f"ML Engineer {number} @ Acme" for number in range(4)]
    forwarded = await bus.redis.xrange(Stream.FILTERED.value)
    lanes = {JobMessage.model_validate_json(fields[PAYLOAD_FIELD]).lane for _, fields in forwarded}
    assert lanes == {2}  # the job keeps its row for the next agent


async def test_rows_work_at_the_same_time(bus: Bus, monkeypatch) -> None:
    import asyncio

    running = most = 0

    async def handle(msg: JobMessage) -> StageResult:
        nonlocal running, most
        running += 1
        most = max(most, running)
        await asyncio.sleep(0.03)
        running -= 1
        return StageResult(msg)

    for number in range(4):
        await bus.publish(Stream.RAW, _job(number, lane=number % 2 + 1))
    _, stage = await _start_stage(bus, handle, monkeypatch, rows=2)

    async def all_forwarded() -> bool:
        return await bus.redis.xlen(Stream.FILTERED.value) == 4

    await _until(all_forwarded)
    await _end(stage)

    assert most == 2


async def test_a_stopped_run_lets_go_of_its_jobs_in_progress_and_waiting(
    bus: Bus, monkeypatch
) -> None:
    import asyncio

    from leadscout_common.shared_state import stop_run
    from leadscout_common.worker import STOPPED_REASON

    begun = asyncio.Event()

    async def handle(msg: JobMessage) -> StageResult:
        if msg.run_id == "stopped-run":
            begun.set()
            await asyncio.sleep(3600)  # a model call that would take minutes
        return StageResult(msg)

    await bus.publish(Stream.RAW, _job(0, lane=1, run_id="stopped-run"))  # will be in progress
    await bus.publish(Stream.RAW, _job(1, lane=1, run_id="stopped-run"))  # waits behind it
    await bus.publish(Stream.RAW, _job(2, lane=1, run_id="next-run"))
    polling, stage = await _start_stage(bus, handle, monkeypatch, rows=1)
    await asyncio.wait_for(begun.wait(), timeout=5)

    await stop_run(polling, "stopped-run")

    async def next_run_forwarded() -> bool:
        return await bus.redis.xlen(Stream.FILTERED.value) == 1

    await _until(next_run_forwarded)
    await asyncio.sleep(0.05)  # let the last acknowledgement land
    await _end(stage)

    let_go = [e for e in await events(polling) if e.type == EventType.ITEM_DROPPED]
    assert [(e.run_id, e.data["reason"], e.data["stopped"]) for e in let_go] == [
        ("stopped-run", STOPPED_REASON, True),
        ("stopped-run", STOPPED_REASON, True),
    ]
    pending = await bus.redis.xpending(Stream.RAW.value, Agent.FILTER.value)
    assert pending["pending"] == 0  # nothing of the stopped run comes back after a restart


async def test_an_unexpected_error_in_a_row_stops_the_agent(bus: Bus, monkeypatch) -> None:
    """As when jobs ran one at a time: the container restarts and Redis redelivers the job."""
    import asyncio

    from leadscout_common import worker

    async def broken_process(*args, **kwargs) -> None:
        raise RuntimeError("Redis went away for good")

    async def handle(msg: JobMessage) -> StageResult:
        return StageResult(msg)

    monkeypatch.setattr(worker, "process_one", broken_process)
    await bus.publish(Stream.RAW, _job(0, lane=1))
    _, stage = await _start_stage(bus, handle, monkeypatch, rows=1)

    with __import__("pytest").raises(RuntimeError, match="went away"):
        await asyncio.wait_for(stage, timeout=5)
    pending = await bus.redis.xpending(Stream.RAW.value, Agent.FILTER.value)
    assert pending["pending"] == 1  # not acknowledged: delivered again after the restart
