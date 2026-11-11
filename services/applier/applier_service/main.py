"""Applier entrypoint. Runs on the host (it needs Claude Code, Chrome and the polishmycv repo).

It acts only on commands the orchestrator publishes after the user pressed a button for
one specific lead, and handles them one at a time.

Commands are acknowledged before they run: an application must never be replayed after a
crash. So that a crash cannot leave a lead spinning for ever either, the command in
progress is noted in Redis, and an interrupted one is reported as failed (when the worker
is stopped, or at the next start after a hard kill).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

from leadscout_common.bus import Bus
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import Agent, ApplyCommand, Event, EventType, Stream

from .fill_form import NeedsHuman, fill_form
from .settings import ApplierSettings, load_settings
from .tailor import tailor

log = logging.getLogger(__name__)
IN_PROGRESS_KEY = "leadscout:applier:in-progress"
INTERRUPTED = "The applier stopped before this finished. Start it again from the lead page."


def outcome_event(command: ApplyCommand, kind: EventType, **data: object) -> Event:
    return Event(
        agent=Agent.APPLIER,
        type=kind,
        job_id=command.job_id,
        title=f"{command.title} @ {command.company}"[:120],
        data={"action": command.action, **data},
    )


async def handle_command(bus: Bus, command: ApplyCommand, settings: ApplierSettings) -> None:
    """Run one approved action and report it as events on the lead."""
    await bus.redis.set(IN_PROGRESS_KEY, command.model_dump_json())
    await bus.emit(outcome_event(command, EventType.ITEM_STARTED))
    started = time.monotonic()
    try:
        action = tailor if command.action == "tailor" else fill_form
        result = await action(command, settings)
        outcome = outcome_event(command, EventType.ITEM_FINISHED, forwarded=False, **result)
    except NeedsHuman as pause:
        outcome = outcome_event(command, EventType.ITEM_WAITING, reason=str(pause))
    except asyncio.CancelledError:
        # Ctrl-C or shutdown: tell the lead before going, so it does not wait for ever.
        await asyncio.shield(
            bus.emit(outcome_event(command, EventType.ITEM_FAILED, error=INTERRUPTED))
        )
        await asyncio.shield(bus.redis.delete(IN_PROGRESS_KEY))
        raise
    except Exception as error:
        log.exception("Applier failed on %s", command.job_id)
        outcome = outcome_event(command, EventType.ITEM_FAILED, error=str(error)[:500])
    outcome.duration_ms = int((time.monotonic() - started) * 1000)
    await bus.emit(outcome)
    await bus.redis.delete(IN_PROGRESS_KEY)


async def report_interrupted(bus: Bus) -> None:
    """A command still marked in progress at start-up was cut off by a hard kill."""
    raw = await bus.redis.get(IN_PROGRESS_KEY)
    if raw:
        command = ApplyCommand.model_validate_json(raw)
        log.warning("Reporting interrupted %s for %s", command.action, command.job_id)
        await bus.emit(outcome_event(command, EventType.ITEM_FAILED, error=INTERRUPTED))
        await bus.redis.delete(IN_PROGRESS_KEY)


def use_host_addresses() -> None:
    """`.env` is written for containers; this worker runs on the host itself."""
    url = os.environ.get("LANGFUSE_BASE_URL", "")
    if "host.docker.internal" in url:
        os.environ["LANGFUSE_BASE_URL"] = url.replace("host.docker.internal", "localhost")


async def main() -> None:
    setup_logging("applier")
    use_host_addresses()
    settings = load_settings()
    bus = Bus()
    await report_interrupted(bus)
    log.info("Applier ready; polishmycv at %s", settings.polishmycv_home)
    async for message_id, command in bus.consume(Stream.APPLY, Agent.APPLIER.value, ApplyCommand):
        await bus.ack(Stream.APPLY, Agent.APPLIER.value, message_id)
        waited_s = time.time() - int(message_id.split("-")[0]) / 1000
        if waited_s > settings.max_command_age_s:
            # Pressed while the applier was off: do not start a paid session out of the blue.
            reason = f"Waited {waited_s / 60:.0f} min for the applier. Press the button again."
            await bus.emit(outcome_event(command, EventType.ITEM_FAILED, error=reason))
            continue
        await handle_command(bus, command, settings)


if __name__ == "__main__":
    asyncio.run(main())
