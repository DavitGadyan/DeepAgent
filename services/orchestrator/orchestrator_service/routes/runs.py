"""Runs, their event history, the live event stream, the pipeline graph and settings."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from leadscout_common.schemas import (
    Agent,
    Event,
    EventType,
    RunCommand,
    RunOptions,
    Settings,
    Stream,
    new_id,
)
from leadscout_common.shared_state import load_catalogue, save_settings
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from ..db import EventRow, RunRow
from ..deps import BroadcasterDep, BusDep, SessionDep
from ..pipeline import Pipeline, build_pipeline
from ..projector import EMPTY_STATS
from ..settings_store import read_settings, write_settings

router = APIRouter(prefix="/api")
SSE_KEEPALIVE_S = 15


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    options: dict[str, Any]
    stats: dict[str, int]


@router.get("/pipeline")
async def get_pipeline(session: SessionDep, bus: BusDep) -> Pipeline:
    return build_pipeline(await load_catalogue(bus), await read_settings(session, bus))


@router.get("/settings")
async def get_settings(session: SessionDep, bus: BusDep) -> Settings:
    return await read_settings(session, bus)


@router.put("/settings")
async def put_settings(settings: Settings, session: SessionDep, bus: BusDep) -> Settings:
    return await write_settings(session, bus, settings)


@router.get("/runs")
async def list_runs(session: SessionDep) -> list[RunOut]:
    rows = await session.scalars(select(RunRow).order_by(RunRow.started_at.desc()).limit(100))
    return [RunOut.model_validate(row) for row in rows]


@router.post("/runs", status_code=201)
async def start_run(session: SessionDep, bus: BusDep, options: RunOptions | None = None) -> RunOut:
    """Create a run and tell the scout to start. Agents read the settings mirrored to Redis."""
    settings = await read_settings(session, bus)
    await save_settings(bus, settings)
    # Store the limit the run will really use, so the run history shows it.
    options = options or RunOptions()
    options.limit_per_source = options.limit_per_source or settings.limit_per_source

    run = RunRow(id=new_id(), options=options.model_dump(), stats=dict(EMPTY_STATS))
    session.add(run)
    await session.commit()

    await bus.emit(Event(run_id=run.id, agent=Agent.ORCHESTRATOR, type=EventType.RUN_STARTED))
    await bus.publish(Stream.RUNS, RunCommand(run_id=run.id, options=options))
    return RunOut.model_validate(run)


@router.get("/runs/{run_id}")
async def get_run(run_id: str, session: SessionDep) -> RunOut:
    run = await session.get(RunRow, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return RunOut.model_validate(run)


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, session: SessionDep) -> list[Event]:
    rows = await session.scalars(
        select(EventRow).where(EventRow.run_id == run_id).order_by(EventRow.seq)
    )
    return [Event.model_validate(row, from_attributes=True) for row in rows]


@router.get("/events/stream")
async def event_stream(request: Request, broadcaster: BroadcasterDep) -> StreamingResponse:
    """Server-Sent Events: every event of every run, as it is recorded."""

    async def frames() -> AsyncIterator[str]:
        queue = broadcaster.subscribe()
        try:
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=SSE_KEEPALIVE_S)
                    yield f"data: {event.model_dump_json()}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            broadcaster.unsubscribe(queue)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(frames(), media_type="text/event-stream", headers=headers)
