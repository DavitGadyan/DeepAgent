"""Database tables. The orchestrator is the single writer; agents never touch Postgres."""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from leadscout_common.schemas import LeadStatus, utc_now
from sqlalchemy import (
    JSON,
    Connection,
    DateTime,
    Index,
    Integer,
    String,
    inspect,
    select,
    text,
    update,
)
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./leadscout.db")


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, datetime: DateTime(timezone=True)}


class RunRow(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="running")
    started_at: Mapped[datetime] = mapped_column(default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    options: Mapped[dict[str, Any]] = mapped_column(default=dict)
    stats: Mapped[dict[str, Any]] = mapped_column(default=dict)
    scout_done: Mapped[bool] = mapped_column(default=False)


class EventRow(Base):
    """The append-only event log: the trace of every run and the data behind the UI replay."""

    __tablename__ = "events"
    __table_args__ = (
        Index("ix_events_run_seq", "run_id", "seq"),
        Index("ix_events_agent_ts", "agent", "ts"),
    )

    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(32), unique=True)
    ts: Mapped[datetime]
    run_id: Mapped[str] = mapped_column(String(32), default="")
    agent: Mapped[str] = mapped_column(String(24))
    type: Mapped[str] = mapped_column(String(24))
    job_id: Mapped[str] = mapped_column(String(16), default="")
    title: Mapped[str] = mapped_column(String(160), default="")
    duration_ms: Mapped[int | None] = mapped_column(default=None)
    data: Mapped[dict[str, Any]] = mapped_column(default=dict)
    # True when this event is the end of the job's trip through the pipeline. Stored so
    # run statistics can count distinct jobs with plain SQL (see projector.ends_job).
    ends_job: Mapped[bool] = mapped_column(default=False)


class LeadRow(Base):
    __tablename__ = "leads"

    job_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(32), default="")
    status: Mapped[str] = mapped_column(String(16), default=LeadStatus.NEW.value, index=True)
    score: Mapped[int | None] = mapped_column(default=None, index=True)
    # Columns copied out of the JSON blobs so the leads table can filter and sort on them.
    title: Mapped[str] = mapped_column(String(300), default="")
    company: Mapped[str] = mapped_column(String(200), default="")
    location: Mapped[str] = mapped_column(String(300), default="")
    source: Mapped[str] = mapped_column(String(40), default="", index=True)
    url: Mapped[str] = mapped_column(String(1000), default="")
    remote_policy: Mapped[str] = mapped_column(String(16), default="unknown")
    seniority: Mapped[str] = mapped_column(String(16), default="unknown")
    role_family: Mapped[str] = mapped_column(String(80), default="")
    posted_at: Mapped[datetime | None] = mapped_column(default=None)
    updated_at: Mapped[datetime] = mapped_column(default=utc_now, onupdate=utc_now)
    job: Mapped[dict[str, Any]] = mapped_column(default=dict)
    extracted: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    score_detail: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    brief: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    application: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    # The last pipeline step that failed for this job: {"agent": ..., "error": ...}.
    pipeline_error: Mapped[dict[str, Any] | None] = mapped_column(default=None)


class SettingsRow(Base):
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    value: Mapped[dict[str, Any]] = mapped_column(default=dict)


def make_engine(url: str | None = None) -> AsyncEngine:
    return create_async_engine(url or database_url(), pool_pre_ping=True)


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)


async def create_tables(engine: AsyncEngine) -> None:
    """Create missing tables, then add the columns later versions introduced.

    There is no migration tool yet; `upgrade_schema` keeps a database created by an
    earlier version working.
    """
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(upgrade_schema)


# (table, column, SQL type and default) added after the first release.
ADDED_COLUMNS = [
    ("events", "ends_job", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("leads", "pipeline_error", "JSON"),
]


def upgrade_schema(connection: Connection) -> None:
    for table, column, definition in ADDED_COLUMNS:
        present = {c["name"] for c in inspect(connection).get_columns(table)}
        if column not in present:
            connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))
            if column == "ends_job":
                _backfill_ends_job(connection)
    connection.execute(text("CREATE INDEX IF NOT EXISTS ix_events_agent_ts ON events (agent, ts)"))


def _backfill_ends_job(connection: Connection) -> None:
    """Mark the stored events that ended a job, by the rule `projector.ends_job` applies."""
    from leadscout_common.schemas import Event

    from .projector import ends_job

    columns = (EventRow.seq, EventRow.agent, EventRow.type, EventRow.job_id, EventRow.data)
    rows = connection.execute(select(*columns).where(EventRow.job_id != ""))
    ended = [
        seq
        for seq, agent, kind, job_id, data in rows
        if ends_job(Event(agent=agent, type=kind, job_id=job_id, data=data or {}))
    ]
    if ended:
        connection.execute(update(EventRow).where(EventRow.seq.in_(ended)).values(ends_job=True))
