"""Researcher agent entrypoint: high-scoring jobs in, company briefs out. Last pipeline stage."""

from __future__ import annotations

import asyncio

from leadscout_common.bus import Bus
from leadscout_common.checkpoints import graph_shape, open_checkpointer
from leadscout_common.config import agent_config
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import Agent, JobMessage, Stream
from leadscout_common.shared_state import save_graph
from leadscout_common.worker import StageResult, run_stage

from .agent import build_agent, research


async def main() -> None:
    setup_logging("researcher")
    config = agent_config("researcher")
    bus = Bus()
    agent = build_agent(config, await open_checkpointer())
    await save_graph(bus, Agent.RESEARCHER.value, graph_shape(agent))

    async def handle(message: JobMessage) -> StageResult:
        message.brief = await research(agent, message, config)
        return StageResult(
            message, forward=False, data={"brief": message.brief.model_dump(mode="json")}
        )

    # One attempt: the research is long and its tools report their own errors to the model.
    await run_stage(Agent.RESEARCHER, Stream.SCORED, None, handle, bus, attempts=1)


if __name__ == "__main__":
    asyncio.run(main())
