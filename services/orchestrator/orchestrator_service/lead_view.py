"""The lead as the leads table shows it: used by the API and by the live push."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from leadscout_common.schemas import Agent, Event, EventType
from pydantic import BaseModel, ConfigDict


class LeadSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    job_id: str
    status: str
    score: int | None
    title: str
    company: str
    location: str
    source: str
    url: str
    remote_policy: str
    seniority: str
    role_family: str
    posted_at: datetime | None
    # When LeadScout found the posting (the filter let it through).
    created_at: datetime
    updated_at: datetime


def lead_summary(lead: Any) -> dict[str, Any]:
    return LeadSummary.model_validate(lead).model_dump(mode="json")


# An agent starting on a job, or moving inside its graph, changes nothing on the lead.
UNCHANGED_BY = {EventType.ITEM_STARTED, EventType.ITEM_PROGRESS}


def may_change_lead(event: Event) -> bool:
    """Whether the leads table can look different after this event."""
    if not event.job_id:
        return False
    return event.agent == Agent.APPLIER or event.type not in UNCHANGED_BY
