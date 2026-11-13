"""Leads: list, detail, status changes, and the two human-approved applier actions."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from leadscout_common.schemas import Agent, ApplyCommand, Event, EventType, LeadStatus, Stream
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..application_files import applications_dir
from ..costs import month_budget_left
from ..db import LeadRow
from ..deps import BroadcasterDep, BusDep, SessionDep
from ..lead_view import LeadSummary
from ..projector import restored_status
from ..settings_store import read_settings

router = APIRouter(prefix="/api/leads")
CAN_FILL_FORM = {LeadStatus.CV_READY.value, LeadStatus.FORM_FILLED.value, LeadStatus.FAILED.value}
APPLIER_BUSY = {LeadStatus.TAILORING.value, LeadStatus.FILLING.value}


class LeadOut(LeadSummary):
    job: dict[str, Any]
    extracted: dict[str, Any] | None
    score_detail: dict[str, Any] | None
    brief: dict[str, Any] | None
    application: dict[str, Any] | None
    pipeline_error: dict[str, Any] | None


ORDER = {
    "newest": (LeadRow.created_at.desc(), LeadRow.job_id),
    "score": (LeadRow.score.desc().nulls_last(), LeadRow.created_at.desc(), LeadRow.job_id),
}


class LeadPage(BaseModel):
    items: list[LeadSummary]
    total: int


class StatusChange(BaseModel):
    """`new` restores a skipped lead, or resets one stuck while the applier was stopped."""

    status: Literal["new", "skipped", "applied"]


async def _lead_or_404(session: AsyncSession, job_id: str) -> LeadRow:
    lead = await session.get(LeadRow, job_id)
    if lead is None:
        raise HTTPException(404, "Lead not found")
    return lead


@router.get("")
async def list_leads(
    session: SessionDep,
    min_score: int | None = None,
    status: str | None = None,
    source: str | None = None,
    remote: bool = False,
    q: str | None = None,
    found_after: datetime | None = None,
    found_before: datetime | None = None,
    sort: Literal["newest", "score"] = "newest",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> LeadPage:
    """Leads, newest found first (or best score first, unscored last).

    `found_after` / `found_before` bound the time LeadScout found the posting.
    """
    conditions = []
    if found_after:
        conditions.append(LeadRow.created_at >= found_after)
    if found_before:
        conditions.append(LeadRow.created_at < found_before)
    if min_score:
        conditions.append(LeadRow.score >= min_score)
    if status:
        conditions.append(LeadRow.status == status)
    if source:
        conditions.append(LeadRow.source == source)
    if remote:
        conditions.append(LeadRow.remote_policy == "remote")
    if q:
        pattern = f"%{q.lower()}%"
        conditions.append(
            or_(func.lower(LeadRow.title).like(pattern), func.lower(LeadRow.company).like(pattern))
        )

    total = await session.scalar(select(func.count()).select_from(LeadRow).where(*conditions))
    rows = await session.scalars(
        select(LeadRow).where(*conditions).order_by(*ORDER[sort]).limit(limit).offset(offset)
    )
    return LeadPage(items=[LeadSummary.model_validate(row) for row in rows], total=total or 0)


@router.get("/{job_id}")
async def get_lead(job_id: str, session: SessionDep) -> LeadOut:
    return LeadOut.model_validate(await _lead_or_404(session, job_id))


@router.patch("/{job_id}")
async def change_status(
    job_id: str,
    change: StatusChange,
    session: SessionDep,
    bus: BusDep,
    broadcaster: BroadcasterDep,
) -> LeadOut:
    lead = await _lead_or_404(session, job_id)
    was_busy = lead.status in APPLIER_BUSY
    lead.status = restored_status(lead) if change.status == "new" else change.status
    await session.commit()
    broadcaster.publish_lead(lead)
    if was_busy:
        # Settle the Applier node on the pipeline graph; the lead itself is already reset.
        await bus.emit(
            Event(
                agent=Agent.APPLIER,
                type=EventType.ITEM_DROPPED,
                job_id=lead.job_id,
                title=f"{lead.title} @ {lead.company}"[:120],
                data={"reason": "Reset by you while the applier was working"},
            )
        )
    return LeadOut.model_validate(lead)


@router.post("/{job_id}/tailor", status_code=202)
async def tailor_cv(
    job_id: str, session: SessionDep, bus: BusDep, broadcaster: BroadcasterDep
) -> LeadOut:
    """User approval #1: ask the applier to tailor the CV and cover letter for this job."""
    lead = await _lead_or_404(session, job_id)
    _refuse_while_busy(lead)
    await _refuse_over_budget(session, bus)
    lead.status = LeadStatus.TAILORING.value
    await session.commit()
    broadcaster.publish_lead(lead)
    await bus.publish(Stream.APPLY, _apply_command(lead, "tailor"))
    return LeadOut.model_validate(lead)


@router.post("/{job_id}/apply", status_code=202)
async def fill_form(
    job_id: str, session: SessionDep, bus: BusDep, broadcaster: BroadcasterDep
) -> LeadOut:
    """User approval #2: ask the applier to fill the form. It never presses Submit."""
    lead = await _lead_or_404(session, job_id)
    _refuse_while_busy(lead)
    if lead.status not in CAN_FILL_FORM or not (lead.application or {}).get("files"):
        raise HTTPException(409, "Tailor the CV first")
    await _refuse_over_budget(session, bus)
    lead.status = LeadStatus.FILLING.value
    await session.commit()
    broadcaster.publish_lead(lead)
    await bus.publish(Stream.APPLY, _apply_command(lead, "fill_form"))
    return LeadOut.model_validate(lead)


@router.get("/{job_id}/files/{name}")
async def application_file(job_id: str, name: str, session: SessionDep) -> FileResponse:
    lead = await _lead_or_404(session, job_id)
    application = lead.application or {}
    if name not in application.get("files", []):
        raise HTTPException(404, "No such file for this lead")
    path = (applications_dir() / application["dir"] / name).resolve()
    if not path.is_relative_to(applications_dir()) or not path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(path)


async def _refuse_over_budget(session: AsyncSession, bus: BusDep) -> None:
    """No new Claude session once this month's spend reached the budget from the Cost page."""
    settings = await read_settings(session, bus)
    left = await month_budget_left(session, settings.monthly_budget_usd)
    if left is not None and left <= 0:
        raise HTTPException(
            409,
            f"The monthly budget of ${settings.monthly_budget_usd:g} is used up. "
            "Raise it on the Cost page to continue.",
        )


def _refuse_while_busy(lead: LeadRow) -> None:
    """One applier action per lead at a time; a double click must not start two sessions."""
    if lead.status in APPLIER_BUSY:
        raise HTTPException(409, "The applier is already working on this lead")


def _apply_command(lead: LeadRow, action: Literal["tailor", "fill_form"]) -> ApplyCommand:
    return ApplyCommand(
        action=action,
        job_id=lead.job_id,
        url=lead.url,
        title=lead.title,
        company=lead.company,
        description=lead.job.get("description", ""),
        application_dir=(lead.application or {}).get("dir", ""),
    )
