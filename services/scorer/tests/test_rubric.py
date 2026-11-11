"""The scoring arithmetic: everything the model does not need to read is computed here."""

import pytest
from leadscout_common.schemas import ExtractedJob
from scorer_service.rubric import (
    CAP_WHEN_ROLE_DOES_NOT_FIT,
    Candidate,
    Judgement,
    seniority_points,
    skill_points,
    split_skills,
    to_fit_score,
)

ROLE_FIT = {"AI Engineer": 25, "Data Engineer": 12, "Other": 0}
SENIOR = Candidate(level="senior", has_preferences=True)


def judgement(matched: list[str], logistics: int = 15) -> Judgement:
    return Judgement(matched_skills=matched, logistics_points=logistics, concerns=[], rationale="r")


def job(**fields: object) -> ExtractedJob:
    return ExtractedJob(**{"role_family": "AI Engineer", "seniority": "senior", **fields})


def test_only_the_jobs_own_skills_can_match() -> None:
    required = ["Python", "PyTorch", "AWS", "Rust"]
    claimed = ["python", "Py Torch", "AWS", "GA4 tracking", "Web Scraping", "python"]

    matched, missing = split_skills(required, claimed)

    assert matched == ["Python", "PyTorch", "AWS"]
    assert missing == ["Rust"]


def test_the_total_is_the_sum_of_the_parts() -> None:
    fit = to_fit_score(
        judgement(["Python", "SQL", "PyTorch", "AWS"], logistics=10),
        job(required_skills=["Python", "SQL", "PyTorch", "AWS", "Rust"]),
        SENIOR,
        ROLE_FIT,
    )

    assert fit.breakdown == {"skills": 36, "role": 25, "seniority": 15, "logistics": 10}
    assert fit.score == 86
    assert fit.missing_skills == ["Rust"]


def test_a_job_outside_the_target_roles_is_capped() -> None:
    fit = to_fit_score(
        judgement(["C", "RTOS"]),
        job(role_family="Other", required_skills=["C", "RTOS"]),
        SENIOR,
        ROLE_FIT,
    )

    assert fit.breakdown["role"] == 0
    assert fit.score == CAP_WHEN_ROLE_DOES_NOT_FIT


def test_role_matching_ignores_case_and_unlisted_families_count_as_adjacent() -> None:
    assert (
        to_fit_score(judgement([]), job(role_family="ai engineer"), SENIOR, ROLE_FIT).breakdown[
            "role"
        ]
        == 25
    )
    assert (
        to_fit_score(judgement([]), job(role_family="Prompt Engineer"), SENIOR, ROLE_FIT).breakdown[
            "role"
        ]
        == 12
    )


def test_skill_points_scale_with_the_share_matched() -> None:
    assert skill_points(matched=10, missing=0) == 45
    assert skill_points(matched=0, missing=6) == 0
    assert skill_points(matched=0, missing=0) == 22  # nothing listed: the middle


@pytest.mark.parametrize(
    ("fields", "candidate_level", "points"),
    [
        ({"seniority": "senior"}, "senior", 15),
        ({"seniority": "lead"}, "senior", 8),
        ({"seniority": "junior"}, "senior", 0),
        ({"seniority": "unknown", "years_experience": 3}, "mid", 15),
        ({"seniority": "unknown"}, "senior", 10),
        ({"seniority": "senior"}, None, 10),
    ],
)
def test_seniority_is_computed_from_levels(
    fields: dict, candidate_level: str | None, points: int
) -> None:
    assert seniority_points(job(**fields), candidate_level) == points


def test_without_preferences_logistics_is_neutral() -> None:
    no_prefs = Candidate(level="senior", has_preferences=False)

    assert (
        to_fit_score(judgement([], logistics=0), job(), no_prefs, ROLE_FIT).breakdown["logistics"]
        == 10
    )


def test_skills_the_cv_names_count_even_when_the_model_misses_them() -> None:
    required = ["Python", "LangChain", "scikit-learn", "LiveKit"]
    evidence = "Core stack: Python, LangChain, LangGraph, scikit-learn, XGBoost."

    fit = to_fit_score(
        judgement(["Python"]), job(required_skills=required), SENIOR, ROLE_FIT, evidence
    )

    assert fit.matched_skills == ["Python", "LangChain", "scikit-learn"]
    assert fit.missing_skills == ["LiveKit"]
