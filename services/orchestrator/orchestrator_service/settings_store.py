"""User settings: stored in Postgres, mirrored to Redis so agents can read them."""

from __future__ import annotations

from leadscout_common.bus import Bus
from leadscout_common.config import load_yaml
from leadscout_common.schemas import Settings, SourceInfo
from leadscout_common.shared_state import load_catalogue, save_settings
from sqlalchemy.ext.asyncio import AsyncSession

from .db import SettingsRow


def default_settings() -> Settings:
    """First-start values from `config/roles.yaml`."""
    roles = load_yaml("roles.yaml") or {}
    return Settings(
        keywords=roles.get("keywords", []),
        exclude_keywords=roles.get("exclude_keywords", []),
        research_min_score=roles.get("research_min_score", 70),
        limit_per_source=roles.get("limit_per_source", 50),
    )


def with_all_sources(settings: Settings, catalogue: list[SourceInfo]) -> Settings:
    """Give every known adapter an on/off entry; new ones take the default from sources.yaml."""
    defaults = (load_yaml("sources.yaml") or {}).get("enabled", {})
    sources = {
        source.name: settings.sources.get(
            source.name, bool(defaults.get(source.name, not source.scraped))
        )
        for source in catalogue
    }
    return settings.model_copy(update={"sources": sources})


async def read_settings(session: AsyncSession, bus: Bus) -> Settings:
    row = await session.get(SettingsRow, 1)
    stored = Settings.model_validate(row.value) if row else default_settings()
    return with_all_sources(stored, await load_catalogue(bus))


async def write_settings(session: AsyncSession, bus: Bus, settings: Settings) -> Settings:
    row = await session.get(SettingsRow, 1)
    if row is None:
        session.add(SettingsRow(id=1, value=settings.model_dump()))
    else:
        row.value = settings.model_dump()
    await session.commit()
    await save_settings(bus, settings)
    return settings
