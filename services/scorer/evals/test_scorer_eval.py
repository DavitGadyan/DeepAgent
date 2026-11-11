"""Scorer eval: the real model against the real CV (`make evals`, slow on CPU).

Needs PROFILE_CV_PATH. Fit cases must score at least `min_score`, mismatches at most
`max_score`; the bands are wide on purpose, because the point is ranking, not the number.
"""

import json
from pathlib import Path

import pytest
from leadscout_common.config import agent_config
from leadscout_common.schemas import ExtractedJob, JobMessage, JobPosting
from scorer_service.main import score
from scorer_service.profile import load_profile

CASES = json.loads((Path(__file__).parent / "cases.json").read_text())


@pytest.mark.eval
@pytest.mark.parametrize("case", CASES, ids=[f"{case['split']}:{case['id']}" for case in CASES])
async def test_score_lands_in_the_expected_band(case: dict) -> None:
    job = JobPosting(
        source="eval",
        url="https://example.com",
        title=case["title"],
        company=case["company"],
        location=case["location"],
    )
    message = JobMessage(run_id="eval", job=job, extracted=ExtractedJob(**case["extracted"]))

    result = await score(message, load_profile(), agent_config("scorer"))

    print(f"\n[{case['id']}] {result.score}: {result.rationale}")
    assert result.score >= case.get("min_score", 0), result.rationale
    assert result.score <= case.get("max_score", 100), result.rationale
