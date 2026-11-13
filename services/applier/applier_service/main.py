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
import json
import logging
import os
import time
from contextlib import suppress
from dataclasses import replace

from leadscout_common.bus import Bus
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import (
    Agent,
    ApplierStatus,
    ApplyCommand,
    Event,
    EventType,
    Settings,
    Stream,
    utc_now,
)
from leadscout_common.shared_state import load_settings as load_shared_settings
from leadscout_common.shared_state import save_applier_status

from .claude_cli import API_CREDENTIALS
from .fill_form import NeedsHuman, fill_form
from .settings import ApplierSettings, load_settings, read_api_key
from .tailor import tailor

log = logging.getLogger(__name__)
IN_PROGRESS_KEY = "leadscout:applier:in-progress"
INTERRUPTED = "The applier stopped before this finished. Start it again from the lead page."
# The key check reads `.env` (cheap); the login check starts Claude Code (not cheap).
STATUS_EVERY_S = 10
LOGIN_CHECK_EVERY_S = 60


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
    # Kept on every outcome for the Cost page: who paid, and which model it was.
    session = {
        "access": settings.claude_access,
        "model": (settings.tailor_model if command.action == "tailor" else "") or "default",
    }
    try:
        action = tailor if command.action == "tailor" else fill_form
        result = await action(command, settings)
        outcome = outcome_event(
            command, EventType.ITEM_FINISHED, forwarded=False, **session, **result
        )
    except NeedsHuman as pause:
        outcome = outcome_event(
            command, EventType.ITEM_WAITING, reason=str(pause), cost_usd=pause.cost_usd, **session
        )
    except asyncio.CancelledError:
        # Ctrl-C or shutdown: tell the lead before going, so it does not wait for ever.
        await asyncio.shield(
            bus.emit(outcome_event(command, EventType.ITEM_FAILED, error=INTERRUPTED))
        )
        await asyncio.shield(bus.redis.delete(IN_PROGRESS_KEY))
        raise
    except Exception as error:
        log.exception("Applier failed on %s", command.job_id)
        outcome = outcome_event(
            command,
            EventType.ITEM_FAILED,
            error=str(error)[:500],
            cost_usd=getattr(error, "cost_usd", None),  # a failed session still costs
            **session,
        )
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


def with_user_choices(settings: ApplierSettings, chosen: Settings) -> ApplierSettings:
    """Read again for every command, so neither needs a restart: the sign-in and spending
    caps from the Setup page, and the Console key from `.env`."""
    console = chosen.claude_access == "console"
    return replace(
        settings,
        claude_access=chosen.claude_access,
        tailor_budget_usd=chosen.tailor_budget_usd,
        fill_budget_usd=chosen.fill_budget_usd,
        tailor_model=chosen.tailor_model,
        api_key=read_api_key(settings.env_file) if console else "",
    )


async def sign_in_status(claude_bin: str) -> ApplierStatus:
    """Whether Claude Code is signed in to an account (`api_key_set` is left to the caller).

    Only the method and plan are kept; the account's e-mail and organisation are not.
    """
    env = {name: value for name, value in os.environ.items() if name not in API_CREDENTIALS}
    status = ApplierStatus()
    try:
        process = await asyncio.create_subprocess_exec(
            claude_bin, "auth", "status", "--json",
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )  # fmt: skip
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=30)
        auth = json.loads(stdout or b"{}")
    except (OSError, TimeoutError, ValueError) as error:
        log.warning("Could not read the Claude Code sign-in state: %s", error)
        return status
    status.logged_in = bool(auth.get("loggedIn"))
    status.auth_method = str(auth.get("authMethod") or "")
    status.subscription = str(auth.get("subscriptionType") or "")
    return status


async def report_status(bus: Bus, settings: ApplierSettings) -> None:
    """Tell the Setup page this worker runs and how it can sign in, until it stops.

    A key added to `.env` shows within `STATUS_EVERY_S`; a new login within a minute.
    """
    login = ApplierStatus()
    checked_at = -float("inf")
    while True:
        with suppress(Exception):  # a Redis or Claude Code hiccup must not stop the worker
            if time.monotonic() - checked_at >= LOGIN_CHECK_EVERY_S:
                login, checked_at = await sign_in_status(settings.claude_bin), time.monotonic()
            key_set = bool(read_api_key(settings.env_file))
            now = {"api_key_set": key_set, "updated_at": utc_now()}
            await save_applier_status(bus, login.model_copy(update=now))
        await asyncio.sleep(STATUS_EVERY_S)


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
    status = asyncio.create_task(report_status(bus, settings))
    log.info("Applier ready; polishmycv at %s", settings.polishmycv_home)
    async for message_id, command in bus.consume(Stream.APPLY, Agent.APPLIER.value, ApplyCommand):
        await bus.ack(Stream.APPLY, Agent.APPLIER.value, message_id)
        waited_s = time.time() - int(message_id.split("-")[0]) / 1000
        if waited_s > settings.max_command_age_s:
            # Pressed while the applier was off: do not start a paid session out of the blue.
            reason = f"Waited {waited_s / 60:.0f} min for the applier. Press the button again."
            await bus.emit(outcome_event(command, EventType.ITEM_FAILED, error=reason))
            continue
        chosen = await load_shared_settings(bus)
        await handle_command(bus, command, with_user_choices(settings, chosen))
    status.cancel()


if __name__ == "__main__":
    asyncio.run(main())
