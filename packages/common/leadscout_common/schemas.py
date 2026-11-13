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

from pydantic import BaseModel, ConfigDict, Field, field_validator


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


MAX_WORKERS = 16


class RunOptions(BaseModel):
    sources: list[str] = Field(default_factory=list, description="Empty means every enabled source")
    limit_per_source: int = Field(default=0, description="0 means the value from Settings")
    force: bool = Field(
        default=False, description="Re-process postings already seen in earlier runs"
    )
    workers: int = Field(
        default=0, ge=0, le=MAX_WORKERS, description="Parallel workers per agent; 0 keeps Settings"
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
    # The row of the pipeline the job travels in, 1..N. The scout deals the jobs of a run
    # to the rows in turn, and every agent handles a job with its worker of that number, so
    # a job never changes rows. 0: not dealt yet (a message from an older version).
    lane: int = 0

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
    ITEM_PROGRESS = "item.progress"  # a node of the agent's LangGraph graph started


class Event(BaseModel):
    """One step of one agent. The stored event log is the trace and drives the UI replay.

    `data` keys by type:
      item.finished   -> forwarded: bool, plus the stage result (job / extracted / score /
                         brief; applier: action, application_dir, files, cost_usd, ...)
      item.dropped    -> reason: str
      item.failed     -> error: str
      item.waiting    -> reason: str (the applier needs the human)
      item.progress   -> node: str (the graph node that started), resumed: bool (it
                         continued from a checkpoint)
      every item.*    -> worker: int (which of the agent's parallel workers, from 1)
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


# "login": your Claude account (claude.ai subscription), as signed in with `claude auth login`.
# "console": an Anthropic Console API key, `ANTHROPIC_API_KEY` in `.env`, billed per token.
ClaudeAccess = Literal["login", "console"]


class Settings(BaseModel):
    """User-editable settings. The orchestrator owns them and mirrors them to Redis for agents."""

    sources: dict[str, bool] = Field(default_factory=dict, description="adapter name -> enabled")
    keywords: list[str] = Field(default_factory=list, description="Target role phrases")
    exclude_keywords: list[str] = Field(default_factory=list)
    research_min_score: int = 70
    limit_per_source: int = 50
    claude_access: ClaudeAccess = Field(
        default="login", description="How the applier's Claude Code sessions sign in"
    )
    # Caps on what one Claude Code session may spend (`--max-budget-usd`); 0 means no cap.
    tailor_budget_usd: float = Field(default=10, ge=0, le=200)
    fill_budget_usd: float = Field(default=5, ge=0, le=200)
    monthly_budget_usd: float = Field(
        default=0, ge=0, le=100_000, description="Claude spend allowed per month; 0 = no limit"
    )
    workers: int = Field(
        default=1,
        ge=1,
        le=MAX_WORKERS,
        description="Rows of the pipeline: each is one worker of every agent",
    )
    # Model for Tailor CV: "" = Claude Code's default, an alias ("opus", "sonnet", "haiku",
    # "fable") or a full model name. It becomes one `--model` argument, so the pattern
    # also keeps it from looking like an option.
    tailor_model: str = Field(default="", max_length=64, pattern=r"^([a-z][a-z0-9.-]*(\[1m\])?)?$")


class ApplierStatus(BaseModel):
    """What the applier worker reports about itself (Redis, refreshed while it runs)."""

    api_key_set: bool = False
    logged_in: bool = False
    auth_method: str = ""
    subscription: str = ""
    updated_at: datetime = Field(default_factory=utc_now)


# --- Your profile (data/profile/profile.yaml) --------------------------------------


class _ProfileSection(BaseModel):
    """Free-text answers. Empty means "not stated": nothing is guessed from it.

    Unknown keys a user added by hand are kept, so saving from the UI does not drop them.
    """

    model_config = ConfigDict(extra="allow")

    @field_validator("*", mode="before")
    @classmethod
    def as_text(cls, value: Any) -> str:
        # YAML reads `years_of_experience: 7` as a number, and `yes` as a boolean.
        if value is None:
            return ""
        if isinstance(value, bool):
            return "yes" if value else "no"
        return str(value).strip()


class Preferences(_ProfileSection):
    """Read by the scorer (logistics and seniority)."""

    locations: str = Field(default="", max_length=500)
    remote: str = Field(default="", max_length=500)
    contract_types: str = Field(default="", max_length=500)
    minimum_salary: str = Field(default="", max_length=500)
    seniority: str = Field(default="", max_length=500)
    avoid: str = Field(default="", max_length=500)


class Application(_ProfileSection):
    """Read only by the job-applier agent, to fill forms. Never sent to a local model."""

    full_name: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=100)
    city_and_country: str = Field(default="", max_length=200)
    linkedin_url: str = Field(default="", max_length=500)
    website_url: str = Field(default="", max_length=500)
    github_url: str = Field(default="", max_length=500)
    work_authorisation: str = Field(default="", max_length=500)
    needs_visa_sponsorship: str = Field(default="", max_length=500)
    salary_expectation: str = Field(default="", max_length=200)
    notice_period: str = Field(default="", max_length=200)
    willing_to_relocate: str = Field(default="", max_length=500)
    years_of_experience: str = Field(default="", max_length=100)
    how_did_you_hear: str = Field(default="", max_length=200)
    gender: str = Field(default="", max_length=100)
    ethnicity: str = Field(default="", max_length=100)
    veteran_status: str = Field(default="", max_length=100)
    disability_status: str = Field(default="", max_length=100)


class UserProfile(BaseModel):
    preferences: Preferences = Field(default_factory=Preferences)
    application: Application = Field(default_factory=Application)


class GraphNode(BaseModel):
    id: str
    label: str


class GraphEdge(BaseModel):
    source: str
    target: str
    conditional: bool = False


class GraphShape(BaseModel):
    """The nodes and edges of one agent's LangGraph graph, read from the compiled graph."""

    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


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
    # What became of an application, as the company answered.
    IN_REVIEW = "in_review"
    INTERVIEW = "interview"
    REJECTED = "rejected"
    SKIPPED = "skipped"
    FAILED = "failed"
