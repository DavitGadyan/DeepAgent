"""Small pieces of state agents share through Redis instead of calling each other.

- settings:   written by the orchestrator, read by scout / filter / scorer
- catalogue:  written by the scout (its adapters), read by the orchestrator for the graph
- seen jobs:  the scout's memory of postings it already forwarded
- applier:    written by the applier while it runs (sign-in state), read by the orchestrator
- stopped:    written by the orchestrator when the user stops a run, read by every agent
- graphs:     written by each graph agent at start (its LangGraph nodes and edges), read by
              the orchestrator for the expanded view of a node
"""

from __future__ import annotations

from .bus import Bus
from .schemas import ApplierStatus, GraphShape, Settings, SourceInfo

SETTINGS_KEY = "leadscout:settings"
CATALOGUE_KEY = "leadscout:sources"
SEEN_KEY = "leadscout:seen-jobs"
APPLIER_STATUS_KEY = "leadscout:applier:status"
GRAPHS_KEY = "leadscout:graphs"
RUN_STOPPED_KEY = "leadscout:run-stopped:{run_id}"
# Long after the last message of a stopped run can still be in a queue.
RUN_STOPPED_TTL_S = 30 * 24 * 3600
# The applier refreshes its status every minute; a missing key means it is not running.
APPLIER_STATUS_TTL_S = 150


async def save_settings(bus: Bus, settings: Settings) -> None:
    await bus.redis.set(SETTINGS_KEY, settings.model_dump_json())


async def load_settings(bus: Bus) -> Settings:
    raw = await bus.redis.get(SETTINGS_KEY)
    return Settings.model_validate_json(raw) if raw else Settings()


async def save_catalogue(bus: Bus, sources: list[SourceInfo]) -> None:
    await bus.redis.delete(CATALOGUE_KEY)
    if sources:
        await bus.redis.hset(CATALOGUE_KEY, mapping={s.name: s.model_dump_json() for s in sources})


async def load_catalogue(bus: Bus) -> list[SourceInfo]:
    raw = await bus.redis.hgetall(CATALOGUE_KEY)
    return sorted((SourceInfo.model_validate_json(v) for v in raw.values()), key=lambda s: s.name)


async def mark_seen(bus: Bus, job_id: str) -> bool:
    """Remember a job id. Returns True when it was new."""
    return bool(await bus.redis.sadd(SEEN_KEY, job_id))


async def save_applier_status(bus: Bus, status: ApplierStatus) -> None:
    await bus.redis.set(APPLIER_STATUS_KEY, status.model_dump_json(), ex=APPLIER_STATUS_TTL_S)


async def load_applier_status(bus: Bus) -> ApplierStatus | None:
    raw = await bus.redis.get(APPLIER_STATUS_KEY)
    return ApplierStatus.model_validate_json(raw) if raw else None


async def save_graph(bus: Bus, agent: str, shape: GraphShape) -> None:
    await bus.redis.hset(GRAPHS_KEY, agent, shape.model_dump_json())


async def load_graphs(bus: Bus) -> dict[str, GraphShape]:
    raw = await bus.redis.hgetall(GRAPHS_KEY)
    return {agent: GraphShape.model_validate_json(value) for agent, value in raw.items()}


async def stop_run(bus: Bus, run_id: str) -> None:
    """Tell every agent to let go of the jobs of this run."""
    await bus.redis.set(RUN_STOPPED_KEY.format(run_id=run_id), "1", ex=RUN_STOPPED_TTL_S)


async def run_stopped(bus: Bus, run_id: str) -> bool:
    return bool(run_id) and bool(await bus.redis.exists(RUN_STOPPED_KEY.format(run_id=run_id)))
