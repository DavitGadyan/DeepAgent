"""The scoring rubric: the model judges what needs reading, the code decides the rest.

A fit score has four parts that add up to 100:

  skills     45  share of the job's required skills the candidate shows evidence for
  role       25  how well the job's role family fits the target roles (config/roles.yaml)
  seniority  15  the job's level against the candidate's level
  logistics  15  location, remote policy, contract and pay against stated preferences

Small models classify well and compute badly: a 7B model matched 8 of 10 skills and
answered 42, and gave "AI Engineer" 0 of 25 for role. So the model is asked only for the
two things that need language understanding (which required skills the CV evidences, and
whether the logistics conflict with free-text preferences). Role, seniority and all the
arithmetic are computed here, the same way every time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from leadscout_common.schemas import ExtractedJob, FitScore
from leadscout_common.text import contains_phrase
from pydantic import BaseModel, Field

SKILL_POINTS = 45
ROLE_POINTS = 25
SENIORITY_POINTS = 15
LOGISTICS_POINTS = 15

# A posting that lists no skills cannot be matched either way: give the middle.
SKILL_POINTS_WHEN_NONE_LISTED = SKILL_POINTS // 2
# A role family the table does not mention is treated as adjacent, not as a miss.
ROLE_POINTS_WHEN_UNLISTED = 12
SENIORITY_ONE_LEVEL_OFF = 8
POINTS_WHEN_UNKNOWN = 10
# A job outside the target roles is never a top lead, however many skills overlap.
CAP_WHEN_ROLE_DOES_NOT_FIT = 49

LEVELS = ["intern", "junior", "mid", "senior", "lead", "principal"]


class Judgement(BaseModel):
    """What the model is asked for (see `prompts/system.md`)."""

    matched_skills: list[str] = Field(
        description="Required skills the candidate shows, copied exactly"
    )
    logistics_points: int = Field(ge=0, le=LOGISTICS_POINTS)
    concerns: list[str]
    rationale: str


@dataclass(frozen=True)
class Candidate:
    """The facts about the candidate that the code, not the model, scores against."""

    level: str | None  # one of LEVELS, or None when unknown
    has_preferences: bool


def level_for_years(years: int) -> str:
    """The level a number of years usually means: the same rule the extractor is given."""
    if years < 2:
        return "junior"
    if years < 5:
        return "mid"
    return "senior" if years < 10 else "lead"


def _key(skill: str) -> str:
    """Compare skills ignoring case, spacing and punctuation: 'Py Torch' equals 'pytorch'."""
    return re.sub(r"[^a-z0-9+#]", "", skill.lower())


def split_skills(required: list[str], claimed: list[str]) -> tuple[list[str], list[str]]:
    """(matched, missing) among the required skills.

    Only skills the job requires can count: anything else the model lists is ignored, and
    whatever it did not list is missing. Both lists therefore always add up to `required`.
    """
    claimed_keys = {_key(skill) for skill in claimed} - {""}
    matched = [skill for skill in required if _key(skill) in claimed_keys]
    missing = [skill for skill in required if _key(skill) not in claimed_keys]
    return matched, missing


def skill_points(matched: int, missing: int) -> int:
    total = matched + missing
    if total == 0:
        return SKILL_POINTS_WHEN_NONE_LISTED
    return round(SKILL_POINTS * matched / total)


def role_points(role_family: str, role_fit: dict[str, int]) -> int:
    """Points for the job's role family from the user's table; matching ignores case."""
    table = {family.lower(): points for family, points in role_fit.items()}
    points = table.get(role_family.strip().lower(), ROLE_POINTS_WHEN_UNLISTED)
    return max(0, min(ROLE_POINTS, points))


def seniority_points(job: ExtractedJob, candidate_level: str | None) -> int:
    """Same level: full marks. One level apart: partial. Further apart: none."""
    job_level = job.seniority
    if job_level == "unknown" and job.years_experience is not None:
        job_level = level_for_years(job.years_experience)
    if job_level not in LEVELS or candidate_level not in LEVELS:
        return POINTS_WHEN_UNKNOWN
    distance = abs(LEVELS.index(job_level) - LEVELS.index(candidate_level))
    return {0: SENIORITY_POINTS, 1: SENIORITY_ONE_LEVEL_OFF}.get(distance, 0)


def named_in(evidence: str, skills: list[str]) -> list[str]:
    """Required skills the candidate's own text names outright (whole words, any case).

    A 7B model matched only "Python" against a CV that names LangChain, LangGraph and
    scikit-learn; what can be found by reading literally is not left to the model.
    """
    return [skill for skill in skills if contains_phrase(evidence, skill)]


def to_fit_score(
    judgement: Judgement,
    job: ExtractedJob,
    candidate: Candidate,
    role_fit: dict[str, int],
    evidence: str = "",
) -> FitScore:
    """Combine the model's judgement with the computed parts into the final score.

    `evidence` is the candidate's CV and portfolio text; skills it names count as matched
    in addition to the related skills the model recognised.
    """
    claimed = judgement.matched_skills + named_in(evidence, job.required_skills)
    matched, missing = split_skills(job.required_skills, claimed)
    breakdown = {
        "skills": skill_points(len(matched), len(missing)),
        "role": role_points(job.role_family, role_fit),
        "seniority": seniority_points(job, candidate.level),
        # Without stated preferences there is nothing to conflict with.
        "logistics": judgement.logistics_points
        if candidate.has_preferences
        else POINTS_WHEN_UNKNOWN,
    }
    total = sum(breakdown.values())
    if breakdown["role"] == 0:
        total = min(total, CAP_WHEN_ROLE_DOES_NOT_FIT)
    return FitScore(
        score=total,
        breakdown=breakdown,
        rationale=judgement.rationale,
        matched_skills=matched,
        missing_skills=missing,
        concerns=judgement.concerns,
    )
