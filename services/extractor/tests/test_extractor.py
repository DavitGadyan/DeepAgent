from extractor_service.main import posting_as_prompt, tidy
from leadscout_common.schemas import ExtractedJob, JobPosting

JOB = JobPosting(
    source="jobicy", url="https://x.test", title="AI Engineer", company="Acme", remote=True
)


def test_the_board_remote_flag_reaches_the_model_and_the_result() -> None:
    assert "Remote (according to the job board): yes" in posting_as_prompt(JOB, 8192)
    assert tidy(ExtractedJob(role_family="AI Engineer"), JOB).remote_policy == "remote"


def test_placeholders_are_removed_from_lists() -> None:
    extracted = ExtractedJob(
        role_family="AI Engineer", benefits=["unknown"], required_skills=["Python", "N/A"]
    )

    tidied = tidy(extracted, JOB)

    assert (tidied.benefits, tidied.required_skills) == ([], ["Python"])


def test_long_postings_are_clipped_to_the_context_window() -> None:
    long_job = JOB.model_copy(update={"description": "word " * 20_000})

    assert len(posting_as_prompt(long_job, 4096)) < 4096 * 4


async def test_facts_and_key_points_are_asked_for_separately(monkeypatch) -> None:
    from extractor_service import main as extractor
    from leadscout_common.config import AgentConfig
    from leadscout_common.schemas import JobFacts, JobHighlights

    asked = []

    async def fake_call(config, schema, system, user):
        asked.append(schema)
        assert "<posting>" in user
        if schema is JobFacts:
            return JobFacts(role_family="AI Engineer", required_skills=["Python"])
        return JobHighlights(summary="Build agents.", benefits=["unknown"])

    monkeypatch.setattr(extractor, "structured_call", fake_call)

    extracted = await extractor.extract(JOB, AgentConfig(model="m"))

    assert asked == [JobFacts, JobHighlights]
    assert (extracted.required_skills, extracted.summary, extracted.benefits) == (
        ["Python"],
        "Build agents.",
        [],
    )
    assert extracted.remote_policy == "remote"
