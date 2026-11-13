"""Extractor agent: posting text -> structured facts and key points (`ExtractedJob`).

Two small schema-constrained calls instead of one large one. With the single 17-field
schema a 7B model left skills, summary and bullets empty on a real posting; asked for
facts and key points separately, it filled every field and finished sooner, because the
posting is the same prefix in both calls and the model server reuses its cached prompt.

The steps are nodes of a LangGraph graph (facts -> highlights -> tidy) with a checkpoint
after each one, so a job that is cut off after `facts` continues at `highlights`.
"""

from __future__ import annotations

import asyncio
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from leadscout_common.bus import Bus
from leadscout_common.checkpoints import graph_shape, open_checkpointer, run_thread, thread_id
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
from leadscout_common.shared_state import save_graph
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


class ExtractState(TypedDict, total=False):
    """One job's thread. Plain JSON values, so a checkpoint can store them."""

    job: dict[str, Any]
    facts: dict[str, Any]
    highlights: dict[str, Any]
    extracted: dict[str, Any]


def build_graph(config: AgentConfig, checkpointer: Any | None = None) -> Any:
    """facts -> highlights -> tidy, with a checkpoint after each node."""

    def posting(state: ExtractState) -> str:
        return posting_as_prompt(JobPosting.model_validate(state["job"]), config.num_ctx)

    async def facts(state: ExtractState) -> ExtractState:
        task = f"{posting(state)}\n\n{FACTS_TASK}"
        found = await structured_call(config, JobFacts, SYSTEM_PROMPT, task)
        return {"facts": found.model_dump(mode="json")}

    async def highlights(state: ExtractState) -> ExtractState:
        task = f"{posting(state)}\n\n{HIGHLIGHTS_TASK}"
        found = await structured_call(config, JobHighlights, SYSTEM_PROMPT, task)
        return {"highlights": found.model_dump(mode="json")}

    def tidy_up(state: ExtractState) -> ExtractState:
        merged = ExtractedJob(**state["facts"], **state["highlights"])
        cleaned = tidy(merged, JobPosting.model_validate(state["job"]))
        return {"extracted": cleaned.model_dump(mode="json")}

    builder = StateGraph(ExtractState)
    builder.add_node("facts", facts)
    builder.add_node("highlights", highlights)
    builder.add_node("tidy", tidy_up)
    builder.add_edge(START, "facts")
    builder.add_edge("facts", "highlights")
    builder.add_edge("highlights", "tidy")
    builder.add_edge("tidy", END)
    return builder.compile(checkpointer=checkpointer)


async def extract(job: JobPosting, config: AgentConfig, graph: Any | None = None) -> ExtractedJob:
    """Run one posting through the graph; `graph` is reused between jobs by the service."""
    graph = graph or build_graph(config)
    thread = thread_id(job.job_id, Agent.EXTRACTOR.value)
    state = await run_thread(graph, thread, {"job": job.model_dump(mode="json")})
    return ExtractedJob.model_validate(state["extracted"])


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
    bus = Bus()
    config = agent_config("extractor")
    graph = build_graph(config, await open_checkpointer())
    await save_graph(bus, Agent.EXTRACTOR.value, graph_shape(graph))

    async def handle(message: JobMessage) -> StageResult:
        message.extracted = await extract(message.job, config, graph)
        return StageResult(message, data={"extracted": message.extracted.model_dump(mode="json")})

    await run_stage(Agent.EXTRACTOR, Stream.FILTERED, Stream.EXTRACTED, handle, bus)


if __name__ == "__main__":
    asyncio.run(main())
