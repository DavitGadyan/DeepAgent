"""Filter eval: real embeddings (bge-m3 through Ollama) on labelled job titles.

`train` titles were used to choose the rule and its thresholds; `holdout` titles were not.
Run with `make evals`. A change to the rule, anchors or thresholds is kept only if the
combined numbers improve.

This measures titles alone, which is the hard case. In the pipeline a dropped title gets
one more chance from the posting text (`description_verdict`), so real recall is higher.
Measured 2026-11-11 with bge-m3: train recall 0.93 / precision 0.82, holdout 0.83 / 0.71.
"""

import json
from pathlib import Path

import pytest
from filter_service.embeddings import Embedder
from filter_service.main import embedding_verdict, thresholds_from
from filter_service.rules import keyword_verdict
from leadscout_common.config import agent_config, load_yaml

CASES = json.loads((Path(__file__).parent / "cases.json").read_text())
# Recall matters more than precision: a wrongly kept title costs one LLM call and scores
# low later; a wrongly dropped one is a lost lead.
# Regression floors just under the measured holdout numbers, not targets.
MIN_RECALL = 0.80
MIN_PRECISION = 0.65


@pytest.mark.eval
@pytest.mark.parametrize("split", ["train", "holdout"])
async def test_filter_recall_and_precision(split: str) -> None:
    roles = load_yaml("roles.yaml")
    embedder = Embedder(agent_config("filter"))
    cases = [case for case in CASES if case["split"] == split]

    async def keeps(title: str) -> bool:
        verdict = keyword_verdict(title, roles["keywords"], roles["exclude_keywords"])
        verdict = verdict or await embedding_verdict(
            title, roles["keywords"], embedder, thresholds_from(agent_config("filter"))
        )
        return verdict.keep

    kept = {case["title"]: await keeps(case["title"]) for case in cases}

    wanted = [case["title"] for case in cases if case["keep"]]
    unwanted = [case["title"] for case in cases if not case["keep"]]
    missed = [title for title in wanted if not kept[title]]
    false_keeps = [title for title in unwanted if kept[title]]
    recall = 1 - len(missed) / len(wanted)
    precision = (len(wanted) - len(missed)) / max(1, len(wanted) - len(missed) + len(false_keeps))
    print(f"\n[{split}] recall {recall:.2f} precision {precision:.2f}")
    print(f"  missed={missed}\n  false_keeps={false_keeps}")

    assert recall >= MIN_RECALL, f"missed target roles: {missed}"
    assert precision >= MIN_PRECISION, f"kept non-target roles: {false_keeps}"
