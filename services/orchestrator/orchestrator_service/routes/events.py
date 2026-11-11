"""Health and event queries that are not tied to one run."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from leadscout_common.schemas import Event
from sqlalchemy import select

from ..db import EventRow
from ..deps import SessionDep

router = APIRouter(prefix="/api")


@router.get("/health")
async def health(request: Request) -> dict[str, str]:
    """503 when the event consumer has stopped, so Docker sees the API as unhealthy."""
    consumer = getattr(request.app.state, "consumer", None)
    if consumer is not None and consumer.done():
        raise HTTPException(503, "Event consumer is not running")
    return {"status": "ok"}


@router.get("/events")
async def list_events(
    session: SessionDep,
    agent: Literal["applier"],
    since: datetime | None = None,
    limit: int = Query(500, ge=1, le=2000),
) -> list[Event]:
    """Events of one agent that is not part of any run (the applier), oldest first.

    The pipeline page merges these into the run it shows, from the run's start onwards.
    """
    query = select(EventRow).where(EventRow.agent == agent)
    if since is not None:
        query = query.where(EventRow.ts >= since)
    rows = await session.scalars(query.order_by(EventRow.ts.desc()).limit(limit))
    return [Event.model_validate(row, from_attributes=True) for row in reversed(list(rows))]
