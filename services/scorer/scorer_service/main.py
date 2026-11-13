"""Scorer agent: extracted job + candidate profile -> `FitScore`.

The model reads (which required skills the CV shows, whether the logistics conflict with
the preferences); `rubric.py` computes role, seniority and the total. Jobs below the
research threshold stop here; the rest go on to the researcher.

The two steps are nodes of a LangGraph graph (judge -> rubric) with a checkpoint after
each, so a job that is cut off after the model call does not pay for it again.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from leadscout_common.bus import Bus
from leadscout_common.checkpoints import graph_shape, open_checkpointer, run_thread, thread_id
from leadscout_common.config import AgentConfig, agent_config, load_yaml
from leadscout_common.llm import load_prompt, structured_call
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import Agent, ExtractedJob, FitScore, JobMessage, Stream
from leadscout_common.shared_state import load_settings, save_graph
from leadscout_common.worker import StageResult, run_stage

from .profile import CandidateProfile, ProfileSource
from .rubric import Judgement, to_fit_score

SYSTEM_PROMPT = load_prompt(__file__, "system")


def role_fit() -> dict[str, int]:
    """Points per role family, from `config/roles.yaml` (`role_fit`)."""
    table = load_yaml("roles.yaml").get("role_fit") or {}
    return {str(family): int(points) for family, points in table.items()}


def job_as_prompt(message: JobMessage, job: ExtractedJob) -> str:
    """The job as the model sees it. The skill list is spelled out because the model must
    pick from it, not invent its own."""
    listed = "\n".join(f"- {skill}" for skill in job.required_skills) or "(none listed)"
    salary = (
        f"{job.salary_min or '?'}-{job.salary_max or '?'} {job.salary_currency}"
        if job.salary_min or job.salary_max
        else message.job.salary or "not stated"
    )
    return (
        f"## Job\nTitle: {message.job.title}\nCompany: {message.job.company}\n"
        f"Location: {', '.join(job.locations) or message.job.location or 'not stated'}\n"
        f"Remote policy: {job.remote_policy}\nContract: {job.contract_type}\n"
        f"Salary: {salary}\nSeniority: {job.seniority}\n"
        f"Years of experience asked: {job.years_experience or 'not stated'}\n"
        f"Summary: {job.summary or 'not stated'}\n\n## Required skills\n{listed}"
    )


class ScoreState(TypedDict, total=False):
    """One job's thread. Plain JSON values, so a checkpoint can store them."""

    message: dict[str, Any]
    judgement: dict[str, Any]
    score: dict[str, Any]


def _extracted(message: JobMessage) -> ExtractedJob:
    return message.extracted or ExtractedJob(role_family="Other")


def build_graph(
    config: AgentConfig,
    profile: Callable[[], CandidateProfile],
    fit: Callable[[], dict[str, int]] = role_fit,
    checkpointer: Any | None = None,
) -> Any:
    """judge (the model reads) -> rubric (the code computes), a checkpoint after each.

    `profile` and `fit` are read when a node runs, so a profile saved on the Setup page
    applies to the next job.
    """

    async def judge(state: ScoreState) -> ScoreState:
        message = JobMessage.model_validate(state["message"])
        user = f"{profile().as_prompt()}\n\n{job_as_prompt(message, _extracted(message))}"
        judgement = await structured_call(config, Judgement, SYSTEM_PROMPT, user)
        return {"judgement": judgement.model_dump(mode="json")}

    def rubric(state: ScoreState) -> ScoreState:
        message = JobMessage.model_validate(state["message"])
        judgement = Judgement.model_validate(state["judgement"])
        candidate = profile()
        result = to_fit_score(
            judgement, _extracted(message), candidate.candidate, fit(), candidate.evidence
        )
        return {"score": result.model_dump(mode="json")}

    builder = StateGraph(ScoreState)
    builder.add_node("judge", judge)
    builder.add_node("rubric", rubric)
    builder.add_edge(START, "judge")
    builder.add_edge("judge", "rubric")
    builder.add_edge("rubric", END)
    return builder.compile(checkpointer=checkpointer)


async def score(
    message: JobMessage,
    profile: CandidateProfile,
    config: AgentConfig,
    fit: dict[str, int] | None = None,
    graph: Any | None = None,
) -> FitScore:
    """Score one job; `graph` is reused between jobs by the service."""
    if graph is None:
        graph = build_graph(config, lambda: profile, (lambda: fit) if fit is not None else role_fit)
    thread = thread_id(message.job_id, Agent.SCORER.value)
    state = await run_thread(graph, thread, {"message": message.model_dump(mode="json")})
    return FitScore.model_validate(state["score"])


async def main() -> None:
    setup_logging("scorer")
    bus = Bus()
    config = agent_config("scorer")
    profiles = ProfileSource()
    profiles.current()  # fail at start-up, not on the first job, when the CV is missing
    graph = build_graph(config, profiles.current, checkpointer=await open_checkpointer())
    await save_graph(bus, Agent.SCORER.value, graph_shape(graph))

    async def handle(message: JobMessage) -> StageResult:
        message.score = await score(message, profiles.current(), config, graph=graph)
        settings = await load_settings(bus)
        worth_researching = message.score.score >= settings.research_min_score
        return StageResult(
            message,
            forward=worth_researching,
            data={"score": message.score.model_dump(mode="json")},
        )

    await run_stage(Agent.SCORER, Stream.EXTRACTED, Stream.SCORED, handle, bus)


if __name__ == "__main__":
    asyncio.run(main())
