"""Filter agent: keep only postings that look like a target role.

Obvious cases are decided by keywords in the title; the rest by whether the title's
embedding is closer to a target role or to another kind of job, with the posting text
as a last chance to keep an oddly titled job. No chat model is involved.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from leadscout_common.bus import Bus
from leadscout_common.config import AgentConfig, agent_config, load_yaml
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import Agent, JobMessage, JobPosting, Stream
from leadscout_common.shared_state import load_settings
from leadscout_common.worker import StageResult, run_stage

from .embeddings import Embedder
from .rules import Verdict, description_verdict, keyword_verdict, similarity_verdict


@dataclass(frozen=True)
class Thresholds:
    """Chosen on the `train` titles of `evals/cases.json`; see that eval before changing."""

    min_margin: float = 0.0
    min_similarity: float = 0.60
    # Distinct target phrases in the posting text that rescue a title the embeddings dropped.
    min_description_mentions: int = 3


def thresholds_from(config: AgentConfig) -> Thresholds:
    """The thresholds the service runs with: `config/agents.toml`, else the defaults."""
    return Thresholds(
        min_margin=float(config.options.get("min_margin", Thresholds.min_margin)),
        min_similarity=float(config.options.get("min_similarity", Thresholds.min_similarity)),
    )


async def judge(
    job: JobPosting, keywords: list[str], exclude: list[str], embedder: Embedder, limits: Thresholds
) -> Verdict:
    """Title keywords, then title embeddings, then the posting text as a last chance to keep."""
    verdict = keyword_verdict(job.title, keywords, exclude)
    if verdict is not None:
        return verdict
    verdict = await embedding_verdict(job.title, keywords, embedder, limits)
    if verdict.keep:
        return verdict
    rescued = description_verdict(job.description, keywords, limits.min_description_mentions)
    return rescued or verdict


async def embedding_verdict(
    title: str, keywords: list[str], embedder: Embedder, limits: Thresholds
) -> Verdict:
    other_roles = (load_yaml("roles.yaml") or {}).get("other_roles", [])
    (title_vector,) = await embedder.embed([title])
    targets = await embedder.role_vectors(keywords)
    others = await embedder.role_vectors(other_roles)
    return similarity_verdict(
        title_vector, targets, others, limits.min_margin, limits.min_similarity
    )


async def main() -> None:
    setup_logging("filter")
    bus = Bus()
    config = agent_config("filter")
    embedder = Embedder(config)
    limits = thresholds_from(config)

    async def handle(message: JobMessage) -> StageResult:
        settings = await load_settings(bus)
        verdict = await judge(
            message.job, settings.keywords, settings.exclude_keywords, embedder, limits
        )
        if not verdict.keep:
            return StageResult(message, drop_reason=verdict.reason)
        # The orchestrator creates the lead from this event, so it carries the posting.
        posting = message.job.model_dump(mode="json")
        return StageResult(message, data={"reason": verdict.reason, "job": posting})

    await run_stage(Agent.FILTER, Stream.RAW, Stream.FILTERED, handle, bus)


if __name__ == "__main__":
    asyncio.run(main())
