"""Prior applications: the import, and what it does to leads found before and after it."""

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from leadscout_common.bus import Bus
from leadscout_common.schemas import Agent, Event, EventType, JobPosting
from orchestrator_service.db import create_tables, make_engine, make_session_factory
from orchestrator_service.event_log import Broadcaster, record_event
from orchestrator_service.main import create_app

JOB = JobPosting(
    source="greenhouse",
    url="https://job-boards.greenhouse.io/toloka/jobs/4909630101",
    title="Forward Deployed AI Engineer",
    company="Toloka",
)
FOLDER = "2026-11-09-toloka-forward-deployed-ai-engineer"
APPLIED = {
    "company": "Toloka",
    "title": "Freelance Forward Deployed AI Engineer",
    "urls": ["https://toloka.ai/careers/info?jid=4909630101&gh_jid=4909630101"],
    "status": "applied",
    "applied_at": "2026-11-09T15:40:05+00:00",
    "application_dir": FOLDER,
    "note": "Applied with AIJobSearch",
}


@pytest.fixture
async def client(bus: Bus, tmp_path: Path, monkeypatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setenv("LEADSCOUT_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("APPLICATIONS_DIR", str(tmp_path / "applications"))
    folder = tmp_path / "applications" / FOLDER
    folder.mkdir(parents=True)
    for name in ("David_Gadyan_CV_Toloka.pdf", "Cover_Letter_Toloka.pdf", "notes.md"):
        (folder / name).write_text("x")
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/test.db")
    await create_tables(engine)
    app = create_app()
    app.state.bus = bus
    app.state.sessions = make_session_factory(engine)
    app.state.broadcaster = Broadcaster()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as http:
        http.app = app  # type: ignore[attr-defined]
        yield http
    await engine.dispose()


async def record(client: AsyncClient, *events: Event) -> None:
    async with client.app.state.sessions() as session:  # type: ignore[attr-defined]
        for event in events:
            await record_event(session, event)
        await session.commit()


def from_agent(agent: Agent, posting: JobPosting = JOB, **data: object) -> Event:
    return Event(agent=agent, type=EventType.ITEM_FINISHED, job_id=posting.job_id, data=data)


def found(posting: JobPosting = JOB) -> Event:
    """The filter's verdict that creates the lead."""
    return from_agent(Agent.FILTER, posting, forwarded=True, job=posting.model_dump(mode="json"))


async def import_(client: AsyncClient, *applications: dict) -> dict:
    response = await client.post("/api/prior-applications", json=list(applications))
    assert response.status_code == 200, response.text
    return response.json()


async def lead(client: AsyncClient, posting: JobPosting = JOB) -> dict:
    return (await client.get(f"/api/leads/{posting.job_id}")).json()


async def test_a_lead_found_after_the_import_starts_with_the_status_and_the_documents(
    client: AsyncClient,
) -> None:
    assert await import_(client, APPLIED) == {"stored": 1, "leads_changed": 0}

    await record(client, found())

    row = await lead(client)
    assert row["status"] == "applied"
    assert row["application"]["dir"] == FOLDER
    assert row["application"]["files"] == [
        "Cover_Letter_Toloka.pdf",
        "David_Gadyan_CV_Toloka.pdf",
    ]
    assert row["application"]["applied_at"].startswith("2026-11-09T15:40:05")
    assert row["application"]["note"] == "Applied with AIJobSearch"
    file = await client.get(f"/api/leads/{JOB.job_id}/files/David_Gadyan_CV_Toloka.pdf")
    assert file.status_code == 200


async def test_a_lead_found_before_the_import_is_brought_in_line(client: AsyncClient) -> None:
    await record(client, found(), from_agent(Agent.SCORER, forwarded=True, score={"score": 80}))

    assert await import_(client, {**APPLIED, "status": "rejected"}) == {
        "stored": 1,
        "leads_changed": 1,
    }

    row = await lead(client)
    assert (row["status"], row["score"]) == ("rejected", 80)
    assert row["application"]["files"]


async def test_the_pipeline_does_not_overwrite_the_imported_status(client: AsyncClient) -> None:
    await import_(client, {**APPLIED, "status": "interview"})

    await record(
        client,
        found(),
        from_agent(Agent.SCORER, forwarded=True, score={"score": 91}),
        from_agent(Agent.RESEARCHER, forwarded=False, brief={"what_they_do": "Data labelling."}),
    )

    row = await lead(client)
    assert (row["status"], row["score"]) == ("interview", 91)
    assert row["brief"]["what_they_do"] == "Data labelling."


async def test_the_same_import_twice_changes_nothing_and_a_later_one_updates(
    client: AsyncClient,
) -> None:
    await record(client, found())
    await import_(client, APPLIED)

    assert (await import_(client, APPLIED))["leads_changed"] == 0
    assert (await import_(client, {**APPLIED, "status": "in_review"}))["leads_changed"] == 1

    assert (await lead(client))["status"] == "in_review"
    assert len((await client.get("/api/prior-applications")).json()) == 1


async def test_a_lead_is_matched_by_company_and_title_when_the_addresses_differ(
    client: AsyncClient,
) -> None:
    elsewhere = JobPosting(
        source="himalayas",
        url="https://himalayas.app/companies/toloka/jobs/freelance-forward-deployed-ai-engineer",
        title="Freelance Forward Deployed AI Engineer",
        company="TOLOKA",
    )
    await import_(client, APPLIED)

    await record(client, found(elsewhere))

    assert (await lead(client, elsewhere))["status"] == "applied"


async def test_a_different_job_of_the_same_company_stays_new(client: AsyncClient) -> None:
    other = JobPosting(
        source="greenhouse",
        url="https://job-boards.greenhouse.io/toloka/jobs/5550001",
        title="Machine Learning Engineer",
        company="Toloka",
    )
    await import_(client, APPLIED)

    await record(client, found(other))

    row = await lead(client, other)
    assert (row["status"], row["application"]) == ("new", None)


async def test_of_two_applications_for_one_job_the_one_that_went_furthest_counts(
    client: AsyncClient,
) -> None:
    same_job_other_spelling = {**APPLIED, "company": "Toloka AI", "status": "rejected"}
    await import_(client, same_job_other_spelling, APPLIED)

    await record(client, found())

    assert (await lead(client))["status"] == "rejected"


async def test_a_missing_folder_gives_the_status_without_documents(client: AsyncClient) -> None:
    await import_(client, {**APPLIED, "application_dir": "../outside", "status": "skipped"})

    await record(client, found())

    row = await lead(client)
    assert (row["status"], row["application"]["files"]) == ("skipped", [])


async def test_a_lead_the_applier_is_working_on_is_left_alone(client: AsyncClient) -> None:
    await record(client, found())
    assert (await client.post(f"/api/leads/{JOB.job_id}/tailor")).status_code == 202

    assert (await import_(client, APPLIED))["leads_changed"] == 0

    assert (await lead(client))["status"] == "tailoring"


async def test_the_list_is_newest_first_and_an_unknown_status_is_refused(
    client: AsyncClient,
) -> None:
    older = {**APPLIED, "company": "Acme", "applied_at": "2026-11-01T10:00:00+00:00"}
    undated = {**APPLIED, "company": "Later", "applied_at": None}
    await import_(client, older, undated, APPLIED)

    listed = (await client.get("/api/prior-applications")).json()
    refused = await client.post("/api/prior-applications", json=[{**APPLIED, "status": "won"}])

    assert [row["company"] for row in listed] == ["Toloka", "Acme", "Later"]
    assert refused.status_code == 422
