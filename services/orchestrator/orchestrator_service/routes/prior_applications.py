"""Import of applications made before LeadScout or outside it."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from .. import prior_applications
from ..db import PriorApplicationRow
from ..deps import BroadcasterDep, SessionDep
from ..prior_applications import PriorApplication

router = APIRouter(prefix="/api/prior-applications")


class ImportResult(BaseModel):
    stored: int
    leads_changed: int


class PriorApplicationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    company: str
    title: str
    urls: list[str]
    status: str
    applied_at: datetime | None
    application_dir: str
    note: str
    imported_at: datetime


@router.post("")
async def import_applications(
    applications: list[PriorApplication], session: SessionDep, broadcaster: BroadcasterDep
) -> ImportResult:
    """Store the applications, then bring every lead for the same job in line with them.

    Sending the same list again changes nothing; a later list updates the statuses.
    """
    await prior_applications.save(session, applications)
    changed = await prior_applications.apply_to_all(session)
    await session.commit()
    for lead in changed:
        broadcaster.publish_lead(lead)
    return ImportResult(stored=len(applications), leads_changed=len(changed))


@router.get("")
async def list_applications(session: SessionDep) -> list[PriorApplicationOut]:
    newest_first = PriorApplicationRow.applied_at.desc().nulls_last()
    rows = await session.scalars(select(PriorApplicationRow).order_by(newest_first))
    return [PriorApplicationOut.model_validate(row) for row in rows]
