"""Turns the event stream into current state: lead rows and run statistics.

Events are the source of truth; leads and run statistics are projections of them. The
lead functions mutate rows that the caller loaded and will commit. Run statistics are
counted from the stored events (distinct jobs), so a redelivered event cannot skew them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from leadscout_common.schemas import Agent, Event, EventType, LeadStatus, utc_now
from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import EventRow, LeadRow, RunRow

EMPTY_STATS = {
    "discovered": 0,
    "dropped": 0,
    "failed": 0,
    "scored": 0,
    "researched": 0,
    "in_flight": 0,
}
PIPELINE_AGENTS = {
    Agent.SCOUT,
    Agent.FILTER,
    Agent.EXTRACTOR,
    Agent.SCORER,
    Agent.RESEARCHER,
}
# Statuses the pipeline may overwrite. Once the user has started applying, it must not.
PIPELINE_STATUSES = {LeadStatus.NEW.value, LeadStatus.SCORED.value, LeadStatus.RESEARCHED.value}


# --- Runs ------------------------------------------------------------------------


def ends_job(event: Event) -> bool:
    """True when the job goes no further in the pipeline after this event."""
    if event.agent not in PIPELINE_AGENTS or not event.job_id:
        return False
    if event.type in (EventType.ITEM_DROPPED, EventType.ITEM_FAILED):
        return True
    return event.type == EventType.ITEM_FINISHED and not event.data.get("forwarded", True)


async def update_run(session: AsyncSession, run: RunRow, event: Event) -> bool:
    """Refresh the run's statistics after `event` was stored. True when it completed the run."""
    if event.type == EventType.SCOUT_DONE:
        run.scout_done = True
    elif not event.job_id or event.agent not in PIPELINE_AGENTS:
        return False
    else:
        run.stats = await count_jobs(session, run.id)

    stats = run.stats or EMPTY_STATS
    completed = run.status == "running" and run.scout_done and stats["in_flight"] <= 0
    if completed:
        run.status = "finished"
        run.finished_at = utc_now()
    return completed


async def count_jobs(session: AsyncSession, run_id: str) -> dict[str, int]:
    """Distinct jobs per outcome in one run, counted from the stored events."""
    jobs = func.count(distinct(EventRow.job_id))
    in_run = (EventRow.run_id == run_id, EventRow.job_id != "")
    by_outcome = await session.execute(
        select(EventRow.agent, EventRow.type, jobs)
        .where(*in_run)
        .group_by(EventRow.agent, EventRow.type)
    )
    counted: dict[tuple[str, str], int] = {(a, t): n for a, t, n in by_outcome}
    ended = await session.scalar(select(jobs).where(*in_run, EventRow.ends_job.is_(True))) or 0

    def total(event_type: EventType, agent: Agent | None = None) -> int:
        return sum(n for (a, t), n in counted.items() if t == event_type and agent in (None, a))

    discovered = total(EventType.ITEM_FINISHED, Agent.SCOUT)
    return {
        "discovered": discovered,
        "dropped": total(EventType.ITEM_DROPPED),
        "failed": total(EventType.ITEM_FAILED),
        "scored": total(EventType.ITEM_FINISHED, Agent.SCORER),
        "researched": total(EventType.ITEM_FINISHED, Agent.RESEARCHER),
        "in_flight": max(0, discovered - ended),
    }


# --- Leads -----------------------------------------------------------------------


def creates_lead(event: Event) -> bool:
    """A lead exists from the moment the filter lets a posting through."""
    return (
        event.agent == Agent.FILTER
        and event.type == EventType.ITEM_FINISHED
        and "job" in event.data
    )


def new_lead(event: Event) -> LeadRow:
    lead = LeadRow(job_id=event.job_id, status=LeadStatus.NEW.value, remote_policy="unknown")
    _copy_posting(lead, event)
    return lead


def apply_to_lead(lead: LeadRow, event: Event) -> None:
    """Fold one event into a lead. Unknown combinations are ignored on purpose."""
    if event.agent == Agent.APPLIER:
        _apply_applier_event(lead, event)
    elif event.type == EventType.ITEM_FINISHED:
        _apply_stage_result(lead, event)
        if (lead.pipeline_error or {}).get("agent") == event.agent.value:
            lead.pipeline_error = None
    elif event.type == EventType.ITEM_FAILED and event.agent in PIPELINE_AGENTS:
        # Shown on the lead page, so a failed step does not look like "not done yet".
        lead.pipeline_error = {"agent": event.agent.value, "error": event.data.get("error", "")}


def _apply_stage_result(lead: LeadRow, event: Event) -> None:
    data = event.data
    if event.agent == Agent.FILTER and "job" in data:
        _copy_posting(lead, event)
    elif event.agent == Agent.EXTRACTOR and (extracted := data.get("extracted")):
        lead.extracted = extracted
        lead.remote_policy = _remote_policy(extracted.get("remote_policy"), lead.job)
        lead.seniority = extracted.get("seniority", "unknown")
        lead.role_family = extracted.get("role_family", "")[:80]
    elif event.agent == Agent.SCORER and (score := data.get("score")):
        lead.score_detail = score
        lead.score = score.get("score")
        _advance(lead, LeadStatus.SCORED)
    elif event.agent == Agent.RESEARCHER and (brief := data.get("brief")):
        lead.brief = brief
        _advance(lead, LeadStatus.RESEARCHED)


def _apply_applier_event(lead: LeadRow, event: Event) -> None:
    """Applier outcomes. A failed form fill never throws away a tailored CV."""
    application: dict[str, Any] = {
        "dir": "",
        "files": [],
        "unanswered": [],
        "error": "",
        **(lead.application or {}),
    }
    data = event.data
    is_fill = data.get("action") == "fill_form"
    if event.type == EventType.ITEM_FINISHED:
        application.update(
            error="", dir=data.get("application_dir", ""), files=data.get("files", [])
        )
        # Claude Code's own figure for the session, at API prices, summed per lead.
        application["cost_usd"] = round(
            (application.get("cost_usd") or 0) + (data.get("cost_usd") or 0), 4
        )
        if is_fill:
            application["unanswered"] = data.get("unanswered", [])
            application["filled_fields"] = data.get("filled_fields", [])
            lead.status = LeadStatus.FORM_FILLED.value
        else:
            lead.status = LeadStatus.CV_READY.value
    elif event.type in (EventType.ITEM_WAITING, EventType.ITEM_FAILED):
        reason = data.get("reason") or data.get("error") or "unknown error"
        application["error"] = reason
        # Login wall, no form, timeout: the CV is still good, so the fill can be retried.
        has_cv = is_fill and bool(application["files"])
        lead.status = LeadStatus.CV_READY.value if has_cv else LeadStatus.FAILED.value
    lead.application = application


def _copy_posting(lead: LeadRow, event: Event) -> None:
    job = event.data["job"]
    lead.run_id = event.run_id
    lead.job = job
    lead.title = job.get("title", "")[:300]
    lead.company = job.get("company", "")[:200]
    lead.location = job.get("location", "")[:300]
    lead.source = job.get("source", "")
    lead.url = job.get("url", "")[:1000]
    lead.posted_at = datetime.fromisoformat(job["posted_at"]) if job.get("posted_at") else None
    lead.remote_policy = _remote_policy(lead.remote_policy, job)


def _remote_policy(policy: str | None, job: dict[str, Any]) -> str:
    """The extracted policy, or 'remote' when only the job board says so."""
    if policy in (None, "", "unknown"):
        return "remote" if job.get("remote") else "unknown"
    return policy


def _advance(lead: LeadRow, status: LeadStatus) -> None:
    if lead.status in PIPELINE_STATUSES:
        lead.status = status.value


def restored_status(lead: LeadRow) -> str:
    """Where a skipped or stuck lead goes back to: its furthest point that still holds."""
    if (lead.application or {}).get("files"):
        return LeadStatus.CV_READY.value
    if lead.brief:
        return LeadStatus.RESEARCHED.value
    return LeadStatus.SCORED.value if lead.score is not None else LeadStatus.NEW.value
