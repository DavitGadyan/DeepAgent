"""Applications made before LeadScout or outside it, and what they mean for a lead.

They are imported (`routes/prior_applications.py`). A lead whose posting is the same job
takes the application's status and the documents that were sent, so a job that was applied
to, answered or rejected elsewhere is not offered as new.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any, Literal

from leadscout_common.schemas import LeadStatus
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .application_files import sent_documents
from .db import LeadRow, PostingKeyRow, PriorApplicationRow
from .posting_keys import posting_keys

PriorStatus = Literal["applied", "in_review", "interview", "rejected", "skipped"]
# When two prior applications are the same job, the one that went furthest counts.
PROGRESS: tuple[PriorStatus, ...] = ("skipped", "applied", "in_review", "interview", "rejected")
# The applier is working on these leads and will write their status itself.
APPLIER_BUSY = {LeadStatus.TAILORING.value, LeadStatus.FILLING.value}


class PriorApplication(BaseModel):
    """One application as the import gives it."""

    company: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    # Every address of the posting: the job board's, the company's own, the form's.
    urls: list[str] = []
    status: PriorStatus
    applied_at: datetime | None = None
    application_dir: str = Field(default="", max_length=300)
    note: str = Field(default="", max_length=500)

    @property
    def id(self) -> str:
        key = f"{self.company.strip().lower()}|{self.title.strip().lower()}"
        return hashlib.sha1(key.encode()).hexdigest()[:16]


async def save(session: AsyncSession, applications: list[PriorApplication]) -> None:
    """Store the applications and their keys. One already stored is replaced, and of one
    given twice the last counts."""
    latest = {application.id: application for application in applications}
    for application in latest.values():
        await session.merge(PriorApplicationRow(id=application.id, **application.model_dump()))
        await session.execute(
            delete(PostingKeyRow).where(PostingKeyRow.application_id == application.id)
        )
        keys = posting_keys(application.urls, application.company, application.title)
        session.add_all(PostingKeyRow(key=key, application_id=application.id) for key in keys)
    await session.flush()


async def find(session: AsyncSession, lead: LeadRow) -> PriorApplicationRow | None:
    """The prior application for the lead's job, if there is one."""
    keys = posting_keys([lead.url], lead.company, lead.title)
    if not keys:
        return None
    rows = await session.scalars(
        select(PriorApplicationRow)
        .join(PostingKeyRow, PostingKeyRow.application_id == PriorApplicationRow.id)
        .where(PostingKeyRow.key.in_(keys))
    )
    return max(rows.unique(), key=lambda row: PROGRESS.index(row.status), default=None)


def apply(lead: LeadRow, prior: PriorApplicationRow) -> bool:
    """Give the lead the prior application's status and documents. True when it changed."""
    if lead.status in APPLIER_BUSY:
        return False
    application: dict[str, Any] = {
        "dir": "",
        "files": [],
        "unanswered": [],
        "error": "",
        **(lead.application or {}),
        "applied_at": prior.applied_at.isoformat() if prior.applied_at else None,
        "note": prior.note,
    }
    if documents := sent_documents(prior.application_dir):
        application.update(dir=prior.application_dir, files=documents)
    changed = lead.status != prior.status or lead.application != application
    lead.status = prior.status
    lead.application = application
    return changed


async def apply_to_lead(session: AsyncSession, lead: LeadRow) -> bool:
    """Apply the lead's prior application, if it has one. True when the lead changed."""
    prior = await find(session, lead)
    return prior is not None and apply(lead, prior)


async def apply_to_all(session: AsyncSession) -> list[LeadRow]:
    """Apply the stored applications to every lead; returns the leads that changed."""
    leads = await session.scalars(select(LeadRow))
    return [lead for lead in leads if await apply_to_lead(session, lead)]
