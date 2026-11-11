"""Typed contracts for everything that crosses a service boundary.

Every message on the bus and every event shown in the UI is one of these models,
so a change here is a change to the public interface of all services.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return uuid.uuid4().hex


# --- Streams -----------------------------------------------------------------


class Stream(StrEnum):
    """Redis Stream names. Each agent reads exactly one and writes the next."""

    RUNS = "runs.start"  # orchestrator -> scout
    RAW = "jobs.raw"  # scout -> filter
    FILTERED = "jobs.filtered"  # filter -> extractor
    EXTRACTED = "jobs.extracted"  # extractor -> scorer
    SCORED = "jobs.scored"  # scorer -> researcher
    APPLY = "apply.requests"  # orchestrator -> applier
    EVENTS = "events"  # every agent -> orchestrator


class Agent(StrEnum):
    SCOUT = "scout"
    FILTER = "filter"
    EXTRACTOR = "extractor"
    SCORER = "scorer"
    RESEARCHER = "researcher"
    APPLIER = "applier"
    ORCHESTRATOR = "orchestrator"


# --- Job data ----------------------------------------------------------------


class JobPosting(BaseModel):
    """A posting as a source adapter found it, before any model has read it."""

    source: str
    url: str
    title: str
    company: str
    location: str = ""
    description: str = ""
    posted_at: datetime | None = None
    remote: bool | None = None
    salary: str = ""
    tags: list[str] = Field(default_factory=list)

    @property
    def job_id(self) -> str:
        """Stable id: the same posting found twice (or on two boards) hashes the same."""
        parts = (self.company, self.title, self.location)
        key = "|".join(part.strip().lower() for part in parts)
        return hashlib.sha1(key.encode()).hexdigest()[:16]


RemotePolicy = Literal["remote", "hybrid", "onsite", "unknown"]
Seniority = Literal["intern", "junior", "mid", "senior", "lead", "principal", "unknown"]
ContractType = Literal["full_time", "part_time", "contract", "freelance", "internship", "unknown"]


class JobFacts(BaseModel):
    """The facts of a posting: what the filters, the scorer and the table use."""

    role_family: str = Field(
        description="Closest target role, e.g. 'AI Engineer' or 'Data Scientist'"
    )
    seniority: Seniority = "unknown"
    remote_policy: RemotePolicy = "unknown"
    contract_type: ContractType = "unknown"
    locations: list[str] = Field(default_factory=list)
    salary_min: int | None = Field(default=None, description="Yearly, in salary_currency")
    salary_max: int | None = None
    salary_currency: str = ""
    years_experience: int | None = None
    required_skills: list[str] = Field(default_factory=list)
    nice_to_have_skills: list[str] = Field(default_factory=list)


class JobHighlights(BaseModel):
    """The posting's key points as short bullets, so nobody has to read the whole text."""

    company_one_liner: str = Field(default="", description="One sentence: what the company does")
    summary: str = Field(default="", description="Two sentences on what the job is")
    responsibilities: list[str] = Field(default_factory=list, description="What you will do")
    requirements: list[str] = Field(default_factory=list, description="Must-haves")
    benefits: list[str] = Field(default_factory=list, description="Pay extras and perks")


class ExtractedJob(JobFacts, JobHighlights):
    """Everything the extractor read out of the posting. It asks for the two halves in
    separate calls: one large schema made a 7B model leave most fields empty."""


class FitScore(BaseModel):
    """How well the job fits the candidate profile."""

    score: int = Field(ge=0, le=100)
    breakdown: dict[str, int] = Field(default_factory=dict, description="Points per rubric part")
    rationale: str = Field(description="Two or three sentences, concrete")
    matched_skills: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    concerns: list[str] = Field(default_factory=list)


class CompanyBrief(BaseModel):
    """What the researcher found about the hiring company. Empty fields mean 'not found'."""

    what_they_do: str = ""
    stage_and_funding: str = ""
    ai_stack: str = ""
    hiring_contact: str = Field(default="", description="Only a publicly listed name/role or page")
    sources: list[str] = Field(default_factory=list, description="URLs the facts came from")


# --- Bus messages --------------------------------------------------------------


class RunOptions(BaseModel):
    sources: list[str] = Field(default_factory=list, description="Empty means every enabled source")
    limit_per_source: int = Field(default=0, description="0 means the value from Settings")
    force: bool = Field(
        default=False, description="Re-process postings already seen in earlier runs"
    )


class RunCommand(BaseModel):
    """Orchestrator -> scout: start a run. The scout reads the current settings when it
    starts the run, so a run queued behind another uses the settings of that moment."""

    run_id: str
    options: RunOptions = Field(default_factory=RunOptions)


class JobMessage(BaseModel):
    """The unit of work passed from stage to stage; each stage fills in its own field."""

    run_id: str
    job: JobPosting
    extracted: ExtractedJob | None = None
    score: FitScore | None = None
    brief: CompanyBrief | None = None

    @property
    def job_id(self) -> str:
        return self.job.job_id


class ApplyCommand(BaseModel):
    """Orchestrator -> applier, sent only after the user pressed a button for this lead."""

    action: Literal["tailor", "fill_form"]
    job_id: str
    url: str
    title: str
    company: str
    description: str = ""
    application_dir: str = Field(
        default="", description="polishmycv output folder, set after tailoring"
    )


# --- Events ----------------------------------------------------------------------


class EventType(StrEnum):
    RUN_STARTED = "run.started"
    RUN_FINISHED = "run.finished"
    SOURCE_STARTED = "source.started"
    SOURCE_FINISHED = "source.finished"
    SOURCE_FAILED = "source.failed"
    SCOUT_DONE = "scout.done"
    ITEM_STARTED = "item.started"
    ITEM_FINISHED = "item.finished"
    ITEM_DROPPED = "item.dropped"
    ITEM_FAILED = "item.failed"
    ITEM_WAITING = "item.waiting"  # an agent is blocked on the human


class Event(BaseModel):
    """One step of one agent. The stored event log is the trace and drives the UI replay.

    `data` keys by type:
      item.finished   -> forwarded: bool, plus the stage result (job / extracted / score /
                         brief; applier: action, application_dir, files, cost_usd, ...)
      item.dropped    -> reason: str
      item.failed     -> error: str
      item.waiting    -> reason: str (the applier needs the human)
      source.finished -> source: str, count: int, new: int, skipped: int
      source.failed   -> source: str, error: str
    docs/api.md lists every key.
    """

    id: str = Field(default_factory=new_id)
    ts: datetime = Field(default_factory=utc_now)
    run_id: str = ""
    agent: Agent
    type: EventType
    job_id: str = ""
    title: str = Field(
        default="", description="Short human label for the UI, e.g. 'ML Engineer @ Acme'"
    )
    duration_ms: int | None = None
    data: dict[str, Any] = Field(default_factory=dict)


# --- Shared settings -----------------------------------------------------------------


class Settings(BaseModel):
    """User-editable settings. The orchestrator owns them and mirrors them to Redis for agents."""

    sources: dict[str, bool] = Field(default_factory=dict, description="adapter name -> enabled")
    keywords: list[str] = Field(default_factory=list, description="Target role phrases")
    exclude_keywords: list[str] = Field(default_factory=list)
    research_min_score: int = 70
    limit_per_source: int = 50


class SourceInfo(BaseModel):
    """What the scout tells everyone else about one of its adapters."""

    name: str
    label: str
    scraped: bool = False


# --- Lead lifecycle -----------------------------------------------------------------


class LeadStatus(StrEnum):
    NEW = "new"
    SCORED = "scored"
    RESEARCHED = "researched"
    TAILORING = "tailoring"
    CV_READY = "cv_ready"
    FILLING = "filling"
    FORM_FILLED = "form_filled"
    APPLIED = "applied"
    SKIPPED = "skipped"
    FAILED = "failed"
