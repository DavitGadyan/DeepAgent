"""The Cost page: what the Claude Code sessions cost, and where to see the real balance."""

from __future__ import annotations

from fastapi import APIRouter, Query

from ..costs import CostReport, build_report, console_links, load_sessions
from ..deps import BusDep, SessionDep
from ..settings_store import read_settings

router = APIRouter(prefix="/api")


class CostPage(CostReport):
    # `console_billing` (the real credit balance) and `langfuse` (per-call detail; '' when
    # tracing is off). Anthropic has no API for the balance, so the page links to it.
    links: dict[str, str]


@router.get("/costs")
async def get_costs(
    session: SessionDep,
    bus: BusDep,
    days: int = Query(30, ge=1, le=366),
    tz_offset_minutes: int = Query(0, ge=-840, le=840),
) -> CostPage:
    """Spend per day for the last `days` days, totals and breakdowns.

    `tz_offset_minutes` is the browser's offset east of UTC, so "today" is the user's day.
    """
    settings = await read_settings(session, bus)
    report = build_report(
        await load_sessions(session), settings.monthly_budget_usd, days, tz_offset_minutes
    )
    return CostPage(**report.model_dump(), links=console_links())
