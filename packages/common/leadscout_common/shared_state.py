"""Small pieces of state agents share through Redis instead of calling each other.

- settings:   written by the orchestrator, read by scout / filter / scorer
- catalogue:  written by the scout (its adapters), read by the orchestrator for the graph
- seen jobs:  the scout's memory of postings it already forwarded
"""

from __future__ import annotations

from .bus import Bus
from .schemas import Settings, SourceInfo

SETTINGS_KEY = "leadscout:settings"
CATALOGUE_KEY = "leadscout:sources"
SEEN_KEY = "leadscout:seen-jobs"


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
