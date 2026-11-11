"""Extractor agent: posting text -> structured facts and key points (`ExtractedJob`).

Two small schema-constrained calls instead of one large one. With the single 17-field
schema a 7B model left skills, summary and bullets empty on a real posting; asked for
facts and key points separately, it filled every field and finished sooner, because the
posting is the same prefix in both calls and Ollama reuses its cached prompt.
"""

from __future__ import annotations

import asyncio

from leadscout_common.config import AgentConfig, agent_config
from leadscout_common.llm import clip, load_prompt, structured_call
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import (
    Agent,
    ExtractedJob,
    JobFacts,
    JobHighlights,
    JobMessage,
    JobPosting,
    Stream,
)
from leadscout_common.worker import StageResult, run_stage

SYSTEM_PROMPT = load_prompt(__file__, "system")
FACTS_TASK = load_prompt(__file__, "facts")
HIGHLIGHTS_TASK = load_prompt(__file__, "highlights")
CHARS_PER_TOKEN = 3.5  # conservative for English job text
RESERVED_TOKENS = 1500  # system prompt, task and JSON answer


def posting_as_prompt(job: JobPosting, num_ctx: int) -> str:
    """The posting as the model sees it, clipped to fit the context window."""
    budget = int((num_ctx - RESERVED_TOKENS) * CHARS_PER_TOKEN)
    remote = "not stated" if job.remote is None else ("yes" if job.remote else "no")
    header = (
        f"Title: {job.title}\nCompany: {job.company}\nLocation: {job.location or 'not stated'}\n"
        f"Remote (according to the job board): {remote}\n"
        f"Salary field: {job.salary or 'not stated'}\nTags: {', '.join(job.tags) or 'none'}\n\n"
    )
    text = clip(job.description or "(no description provided)", budget)
    return f"<posting>\n{header}{text}\n</posting>"


async def extract(job: JobPosting, config: AgentConfig) -> ExtractedJob:
    posting = posting_as_prompt(job, config.num_ctx)
    facts = await structured_call(config, JobFacts, SYSTEM_PROMPT, f"{posting}\n\n{FACTS_TASK}")
    highlights = await structured_call(
        config, JobHighlights, SYSTEM_PROMPT, f"{posting}\n\n{HIGHLIGHTS_TASK}"
    )
    return tidy(ExtractedJob(**facts.model_dump(), **highlights.model_dump()), job)


PLACEHOLDERS = {"", "unknown", "n/a", "none", "not stated", "not specified", "null"}


def tidy(extracted: ExtractedJob, job: JobPosting) -> ExtractedJob:
    """Fix what small models get wrong in a predictable way.

    - A board that lists only remote jobs says so in its flag even when the text does not.
    - "unknown" written inside a list is a placeholder, not an item.
    """
    if extracted.remote_policy == "unknown" and job.remote:
        extracted.remote_policy = "remote"
    for name in (
        "required_skills",
        "nice_to_have_skills",
        "locations",
        "responsibilities",
        "requirements",
        "benefits",
    ):
        items = getattr(extracted, name)
        setattr(extracted, name, [i for i in items if i.strip().lower() not in PLACEHOLDERS])
    return extracted


async def main() -> None:
    setup_logging("extractor")
    config = agent_config("extractor")

    async def handle(message: JobMessage) -> StageResult:
        message.extracted = await extract(message.job, config)
        return StageResult(message, data={"extracted": message.extracted.model_dump(mode="json")})

    await run_stage(Agent.EXTRACTOR, Stream.FILTERED, Stream.EXTRACTED, handle)


if __name__ == "__main__":
    asyncio.run(main())
