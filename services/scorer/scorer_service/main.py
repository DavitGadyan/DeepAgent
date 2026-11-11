"""Scorer agent: extracted job + candidate profile -> `FitScore`.

The model reads (which required skills the CV shows, whether the logistics conflict with
the preferences); `rubric.py` computes role, seniority and the total. Jobs below the
research threshold stop here; the rest go on to the researcher.
"""

from __future__ import annotations

import asyncio

from leadscout_common.bus import Bus
from leadscout_common.config import AgentConfig, agent_config, load_yaml
from leadscout_common.llm import load_prompt, structured_call
from leadscout_common.logs import setup_logging
from leadscout_common.schemas import Agent, ExtractedJob, FitScore, JobMessage, Stream
from leadscout_common.shared_state import load_settings
from leadscout_common.worker import StageResult, run_stage

from .profile import CandidateProfile, load_profile
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


async def score(
    message: JobMessage,
    profile: CandidateProfile,
    config: AgentConfig,
    fit: dict[str, int] | None = None,
) -> FitScore:
    job = message.extracted or ExtractedJob(role_family="Other")
    user = f"{profile.as_prompt()}\n\n{job_as_prompt(message, job)}"
    judgement = await structured_call(config, Judgement, SYSTEM_PROMPT, user)
    fit = role_fit() if fit is None else fit
    return to_fit_score(judgement, job, profile.candidate, fit, profile.evidence)


async def main() -> None:
    setup_logging("scorer")
    bus = Bus()
    config = agent_config("scorer")
    profile = load_profile()

    async def handle(message: JobMessage) -> StageResult:
        message.score = await score(message, profile, config)
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
