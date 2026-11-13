"""What the Claude Code sessions cost, read from the applier's stored events.

Only the applier uses a paid model; the pipeline agents run on your own model server.
Every figure is Claude Code's own number for the session, at API prices. With a Console
API key that is what you are billed; with Claude login nothing is billed per session (it
counts against your plan's usage), so the two are reported apart.
"""

from __future__ import annotations

import os
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta, timezone

from leadscout_common.schemas import Agent, utc_now
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import EventRow

ACTION_LABELS = {"tailor": "Tailor CV", "fill_form": "Fill form"}
ACCESS_LABELS = {"console": "Console API key (billed)", "login": "Claude login (plan usage)"}
TOP_LEADS = 10


class Session(BaseModel):
    """One Claude Code session that reported a cost."""

    ts: datetime
    job_id: str
    title: str
    action: str
    access: str
    model: str
    usd: float


class Amount(BaseModel):
    usd: float = 0
    # The part paid with a Console API key.
    billed_usd: float = 0
    sessions: int = 0


class Slice(BaseModel):
    key: str
    label: str
    usd: float
    billed_usd: float
    sessions: int


class Day(BaseModel):
    date: date
    login_usd: float
    console_usd: float


class LeadCost(BaseModel):
    job_id: str
    title: str
    usd: float
    sessions: int


class CostReport(BaseModel):
    today: Amount
    last_7_days: Amount
    this_month: Amount
    all_time: Amount
    monthly_budget_usd: float
    by_day: list[Day]
    by_action: list[Slice]
    by_model: list[Slice]
    by_access: list[Slice]
    top_leads: list[LeadCost]


async def load_sessions(session: AsyncSession, since: datetime | None = None) -> list[Session]:
    """Applier sessions with a cost, oldest first. Sessions recorded before the access
    switch existed all used Claude login."""
    query = select(EventRow).where(EventRow.agent == Agent.APPLIER.value)
    if since is not None:
        query = query.where(EventRow.ts >= since)
    rows = await session.scalars(query.order_by(EventRow.ts))
    return [
        Session(
            ts=_aware(row.ts),
            job_id=row.job_id,
            title=row.title,
            action=str(row.data.get("action") or "unknown"),
            access=str(row.data.get("access") or "login"),
            model=str(row.data.get("model") or "default"),
            usd=float(row.data["cost_usd"]),
        )
        for row in rows
        if (row.data or {}).get("cost_usd")
    ]


def _aware(moment: datetime) -> datetime:
    """SQLite returns naive datetimes; they were stored in UTC."""
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def build_report(
    sessions: list[Session],
    monthly_budget_usd: float,
    days: int,
    tz_offset_minutes: int = 0,
    now: datetime | None = None,
) -> CostReport:
    """Totals and breakdowns. Days and months are the user's local ones (`tz_offset_minutes`
    east of UTC, as the browser reports it)."""
    zone = timezone(timedelta(minutes=tz_offset_minutes))
    today = (now or utc_now()).astimezone(zone).date()
    week_start = today - timedelta(days=6)
    first_day = today - timedelta(days=days - 1)

    def local_day(item: Session) -> date:
        return item.ts.astimezone(zone).date()

    def amount(chosen: list[Session]) -> Amount:
        return Amount(
            usd=_money(sum(item.usd for item in chosen)),
            billed_usd=_money(sum(item.usd for item in chosen if item.access == "console")),
            sessions=len(chosen),
        )

    def slices(field: str, labels: dict[str, str]) -> list[Slice]:
        groups: dict[str, list[Session]] = defaultdict(list)
        for item in sessions:
            groups[getattr(item, field)].append(item)
        made = [
            Slice(key=key, label=labels.get(key, key), **amount(group).model_dump())
            for key, group in groups.items()
        ]
        return sorted(made, key=lambda made_slice: made_slice.usd, reverse=True)

    per_day: dict[date, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for item in sessions:
        per_day[local_day(item)][item.access] += item.usd
    by_day = [
        Day(
            date=day,
            login_usd=_money(per_day[day]["login"]),
            console_usd=_money(per_day[day]["console"]),
        )
        for day in (first_day + timedelta(days=offset) for offset in range(days))
    ]

    return CostReport(
        today=amount([item for item in sessions if local_day(item) == today]),
        last_7_days=amount([item for item in sessions if local_day(item) >= week_start]),
        this_month=amount([item for item in sessions if _same_month(local_day(item), today)]),
        all_time=amount(sessions),
        monthly_budget_usd=monthly_budget_usd,
        by_day=by_day,
        by_action=slices("action", ACTION_LABELS),
        by_model=slices("model", {"default": "Claude Code's default"}),
        by_access=slices("access", ACCESS_LABELS),
        top_leads=_top_leads(sessions),
    )


def _top_leads(sessions: list[Session]) -> list[LeadCost]:
    groups: dict[str, list[Session]] = defaultdict(list)
    for item in sessions:
        groups[item.job_id].append(item)
    leads = [
        LeadCost(
            job_id=job_id,
            title=group[-1].title,
            usd=_money(sum(item.usd for item in group)),
            sessions=len(group),
        )
        for job_id, group in groups.items()
    ]
    return sorted(leads, key=lambda lead: lead.usd, reverse=True)[:TOP_LEADS]


def _same_month(day: date, today: date) -> bool:
    return (day.year, day.month) == (today.year, today.month)


def _money(value: float) -> float:
    return round(value, 4)


async def month_budget_left(session: AsyncSession, monthly_budget_usd: float) -> float | None:
    """Dollars left in this (UTC) month's budget; None when no budget is set."""
    if not monthly_budget_usd:
        return None
    now = utc_now()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    spent = sum(item.usd for item in await load_sessions(session, since=month_start))
    return monthly_budget_usd - spent


def console_links() -> dict[str, str]:
    """Where the real balance and the per-call detail are."""
    return {
        "console_billing": "https://console.anthropic.com/settings/billing",
        "langfuse": os.environ.get("LANGFUSE_PUBLIC_URL")
        or os.environ.get("LANGFUSE_BASE_URL", "").replace("host.docker.internal", "localhost"),
    }
