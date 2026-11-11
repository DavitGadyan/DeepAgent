"""Extractor eval: the real model on labelled postings (`make evals`, slow on CPU).

Each case lists the fields that must come out exactly and skills that must be found.
Cases are split into `train` (used while writing the prompt) and `holdout` (not), across
two strata, as in LangChain's better-harness example. Keep a prompt change only if the
combined pass count goes up.
"""

import json
from pathlib import Path

import pytest
from extractor_service.main import extract
from leadscout_common.config import agent_config
from leadscout_common.schemas import JobPosting

CASES = json.loads((Path(__file__).parent / "cases.json").read_text())


@pytest.mark.eval
@pytest.mark.parametrize("case", CASES, ids=[f"{case['split']}:{case['id']}" for case in CASES])
async def test_extraction_matches_labels(case: dict) -> None:
    job = JobPosting(
        source="eval",
        url="https://example.com",
        title=case["title"],
        company=case["company"],
        location=case["location"],
        description=case["description"],
    )

    extracted = await extract(job, agent_config("extractor"))

    actual = extracted.model_dump()
    wrong = {key: actual[key] for key, value in case["expect"].items() if actual[key] != value}
    assert not wrong, f"expected {case['expect']}, got different values for {wrong}"
    found = {skill.lower() for skill in extracted.required_skills}
    missing = [skill for skill in case["required_skills_include"] if skill.lower() not in found]
    got = extracted.required_skills
    assert not missing, f"required skills not extracted: {missing} (got {got})"
