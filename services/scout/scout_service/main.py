"""Scout agent entrypoint: wait for run commands, run the source adapters."""

from __future__ import annotations

import asyncio
import logging

from leadscout_common.bus import Bus
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import Agent, RunCommand, SourceInfo, Stream
from leadscout_common.shared_state import save_catalogue

from .runner import execute_run
from .sources import ALL_SOURCES

log = logging.getLogger(__name__)


async def main() -> None:
    setup_logging("scout")
    bus = Bus()
    catalogue = [SourceInfo(name=s.name, label=s.label, scraped=s.scraped) for s in ALL_SOURCES]
    await save_catalogue(bus, catalogue)
    log.info("Published %d sources; waiting for runs", len(catalogue))

    async for message_id, command in bus.consume(Stream.RUNS, Agent.SCOUT.value, RunCommand):
        log.info("Run %s started", command.run_id)
        try:
            await execute_run(bus, command)
        except Exception:
            log.exception("Run %s crashed", command.run_id)
        await bus.ack(Stream.RUNS, Agent.SCOUT.value, message_id)


if __name__ == "__main__":
    asyncio.run(main())
