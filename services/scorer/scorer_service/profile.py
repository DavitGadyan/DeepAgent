"""The candidate side of the comparison: CV text, portfolio skills, stated preferences."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .rubric import LEVELS, Candidate, level_for_years

MAX_CV_CHARS = 8000
MAX_PORTFOLIO_SKILLS = 80


@dataclass(frozen=True)
class CandidateProfile:
    cv_text: str
    portfolio: str
    preferences: str  # empty when the user stated none
    level: str | None  # one of rubric.LEVELS; None when it cannot be told
    # Every skill and tool the portfolio names, for literal matching (too long for the prompt).
    all_skills: str = ""

    @property
    def evidence(self) -> str:
        """Text in which a skill the candidate has is named outright."""
        return f"{self.cv_text}\n{self.portfolio}\n{self.all_skills}"

    @property
    def candidate(self) -> Candidate:
        """The facts the rubric scores in code."""
        return Candidate(level=self.level, has_preferences=bool(self.preferences))

    def as_prompt(self) -> str:
        """What the model sees. Application details (phone, salary…) are never part of it."""
        sections = [f"## Candidate CV\n{self.cv_text}"]
        if self.portfolio:
            sections.append(f"## Evidence from the candidate's portfolio\n{self.portfolio}")
        sections.append(f"## Candidate preferences\n{self.preferences or 'none stated'}")
        return "\n\n".join(sections)


def profile_paths() -> tuple[Path, Path, Path]:
    """CV (`PROFILE_CV_PATH`), portfolio catalogue (`PROFILE_CATALOGUE_PATH`, optional) and
    the user's profile file (`PROFILE_PREFS_PATH`). All are mounted read-only."""
    return (
        Path(os.environ.get("PROFILE_CV_PATH", "data/profile/cv.txt")),
        Path(os.environ.get("PROFILE_CATALOGUE_PATH", "")),
        Path(os.environ.get("PROFILE_PREFS_PATH", "data/profile/profile.yaml")),
    )


class ProfileSource:
    """The current profile, read again when one of its files changed.

    The Setup page saves `profile.yaml`; the next job is scored with the new preferences.
    """

    def __init__(self) -> None:
        self._stamp: tuple[int, ...] | None = None
        self._profile: CandidateProfile | None = None

    def current(self) -> CandidateProfile:
        stamp = tuple(_modified_ns(path) for path in profile_paths())
        if self._profile is None or stamp != self._stamp:
            self._profile, self._stamp = load_profile(), stamp
        return self._profile


def _modified_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns if path.is_file() else 0
    except OSError:
        return 0


def load_profile() -> CandidateProfile:
    """Read the CV, the portfolio catalogue and the profile file (see `profile_paths`).

    A missing CV is a configuration error and stops the service: scoring against nothing
    would produce confident nonsense.
    """
    cv_path, catalogue_path, prefs_path = profile_paths()
    if not cv_path.is_file():
        raise FileNotFoundError(f"CV not found at {cv_path}; set PROFILE_CV_PATH")
    catalogue = _read_json(catalogue_path)
    profile = _read_yaml(prefs_path)

    stated = {key: value for key, value in (profile.get("preferences") or {}).items() if value}
    return CandidateProfile(
        cv_text=cv_path.read_text()[:MAX_CV_CHARS],
        portfolio=_portfolio_summary(catalogue),
        preferences=yaml.safe_dump(stated, sort_keys=False).strip() if stated else "",
        level=candidate_level(stated, profile.get("application") or {}, catalogue),
        all_skills=_all_skill_names(catalogue),
    )


def candidate_level(
    preferences: dict[str, Any], application: dict[str, Any], catalogue: dict[str, Any]
) -> str | None:
    """The candidate's level: stated in `preferences.seniority`, else from years of experience.

    Years come from the profile's `application.years_of_experience` or the portfolio
    catalogue. Only the resulting level is used, and only in code.
    """
    stated = str(preferences.get("seniority", "")).lower()
    for level in reversed(LEVELS):  # "senior or lead" means lead is acceptable: take the higher
        if re.search(rf"\b{level}\b", stated):
            return level
    for source in (application.get("years_of_experience"), _catalogue_years(catalogue)):
        if match := re.search(r"\d+", str(source or "")):
            return level_for_years(int(match.group()))
    return None


def _catalogue_years(catalogue: dict[str, Any]) -> Any:
    return (catalogue.get("profile") or {}).get("experience_years")


def _portfolio_summary(catalogue: dict[str, Any]) -> str:
    """Skills with project evidence, from a polishmycv `portfolio-catalogue.json`.

    A one-page CV names few tools, so scoring on it alone marks real skills as missing.
    The catalogue lists every skill with the projects that used it; the most used come first.
    """
    by_skill = catalogue.get("index_by_skill") or {}
    if not by_skill:
        return ""
    profile = catalogue.get("profile") or {}
    ranked = sorted(by_skill, key=lambda skill: len(by_skill[skill]), reverse=True)
    skills = [f"{skill} ({len(by_skill[skill])})" for skill in ranked[:MAX_PORTFOLIO_SKILLS]]
    lines = [
        f"Positioning: {profile.get('positioning', '')}",
        f"Experience: {profile.get('experience_years', '?')} years, "
        f"{profile.get('projects_delivered', '?')} projects delivered",
        f"Services: {', '.join(profile.get('services', []))}",
        f"Skills used in portfolio projects (number of projects): {', '.join(skills)}",
    ]
    return "\n".join(lines)


def _all_skill_names(catalogue: dict[str, Any]) -> str:
    """Skill index names plus the core stack, e.g. "RAG with vector stores (Pinecone)"."""
    names = list(catalogue.get("index_by_skill") or {})
    for group in ((catalogue.get("profile") or {}).get("core_stack") or {}).values():
        names += [str(item) for item in group] if isinstance(group, list) else []
    return ", ".join(names)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text()) if path.is_file() else {}


def _read_yaml(path: Path) -> dict[str, Any]:
    return (yaml.safe_load(path.read_text()) or {}) if path.is_file() else {}
