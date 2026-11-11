"""API and projection tests on SQLite + in-memory Redis: a whole lead lifecycle from events."""

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from leadscout_common.bus import Bus
from leadscout_common.schemas import Agent, Event, EventType, JobPosting, SourceInfo, Stream
from leadscout_common.shared_state import load_settings, save_catalogue
from orchestrator_service.db import create_tables, make_engine, make_session_factory
from orchestrator_service.event_log import Broadcaster, record_event
from orchestrator_service.main import create_app

JOB = JobPosting(
    source="greenhouse", url="https://example.com/1", title="AI Engineer", company="Acme"
)
SCORE = {
    "score": 82,
    "rationale": "Strong match.",
    "matched_skills": ["Python"],
    "missing_skills": [],
}
UI_ORIGIN = {"Origin": "http://localhost:3000"}


@pytest.fixture
async def client(bus: Bus, tmp_path, monkeypatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setenv("LEADSCOUT_CONFIG_DIR", str(tmp_path))  # no config files: pure defaults
    monkeypatch.setenv("APPLICATIONS_DIR", str(tmp_path / "applications"))
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/test.db")
    await create_tables(engine)
    app = create_app()
    app.state.bus = bus
    app.state.sessions = make_session_factory(engine)
    app.state.broadcaster = Broadcaster()
    await save_catalogue(bus, [SourceInfo(name="greenhouse", label="Greenhouse")])
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://localhost") as http:
        http.app = app  # type: ignore[attr-defined]
        yield http
    await engine.dispose()


async def record(client: AsyncClient, *events: Event) -> list[bool]:
    """Feed events through the same function the stream consumer uses."""
    completed = []
    async with client.app.state.sessions() as session:  # type: ignore[attr-defined]
        for event in events:
            completed.append(await record_event(session, event))
        await session.commit()
    return completed


def item(
    run_id: str,
    agent: Agent,
    kind: EventType = EventType.ITEM_FINISHED,
    posting: JobPosting = JOB,
    **data: object,
) -> Event:
    return Event(run_id=run_id, agent=agent, type=kind, job_id=posting.job_id, data=data)


def filtered(posting: JobPosting = JOB, run_id: str = "") -> Event:
    """The filter's verdict that creates the lead."""
    return item(
        run_id, Agent.FILTER, posting=posting, forwarded=True, job=posting.model_dump(mode="json")
    )


def tailored(files: list[str] | None = None) -> Event:
    return item(
        "",
        Agent.APPLIER,
        action="tailor",
        application_dir="2026-11-11-acme-ai-engineer",
        files=files if files is not None else ["cv.pdf"],
    )


async def lead(client: AsyncClient) -> dict:
    return (await client.get(f"/api/leads/{JOB.job_id}")).json()


# --- Runs ------------------------------------------------------------------------


async def test_start_run_publishes_command_and_mirrors_settings(
    client: AsyncClient, bus: Bus
) -> None:
    response = await client.post("/api/runs", json={"limit_per_source": 5})

    assert response.status_code == 201
    assert response.json()["status"] == "running"
    assert await bus.redis.xlen(Stream.RUNS.value) == 1
    assert (await load_settings(bus)).sources == {"greenhouse": True}


async def test_run_stores_the_limit_it_will_really_use(client: AsyncClient) -> None:
    run = (await client.post("/api/runs", json={})).json()

    assert run["options"]["limit_per_source"] == 50  # the Settings default, not 0


async def test_events_build_a_lead_and_finish_the_run(client: AsyncClient) -> None:
    run_id = (await client.post("/api/runs")).json()["id"]

    completed = await record(
        client,
        item(run_id, Agent.SCOUT, forwarded=True, source="greenhouse"),
        Event(run_id=run_id, agent=Agent.SCOUT, type=EventType.SCOUT_DONE),
        filtered(run_id=run_id),
        item(
            run_id,
            Agent.EXTRACTOR,
            forwarded=True,
            extracted={"remote_policy": "remote", "seniority": "senior"},
        ),
        item(run_id, Agent.SCORER, forwarded=True, score=SCORE),
        item(run_id, Agent.RESEARCHER, forwarded=False, brief={"what_they_do": "Agents."}),
    )

    assert completed == [False] * 5 + [True]  # only the last event ends the run
    run = (await client.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "finished"
    assert run["stats"] == {
        "discovered": 1,
        "dropped": 0,
        "failed": 0,
        "scored": 1,
        "researched": 1,
        "in_flight": 0,
    }
    found = await lead(client)
    assert (found["status"], found["score"], found["remote_policy"]) == ("researched", 82, "remote")
    assert found["brief"]["what_they_do"] == "Agents."
    assert len((await client.get(f"/api/runs/{run_id}/events")).json()) == 6


async def test_redelivered_events_are_counted_once(client: AsyncClient) -> None:
    run_id = (await client.post("/api/runs")).json()["id"]
    other = JobPosting(source="greenhouse", url="https://example.com/2", title="ML", company="B")
    dropped = item(run_id, Agent.FILTER, EventType.ITEM_DROPPED, posting=other, reason="no")

    await record(
        client,
        item(run_id, Agent.SCOUT, forwarded=True),
        item(run_id, Agent.SCOUT, posting=other, forwarded=True),
        Event(run_id=run_id, agent=Agent.SCOUT, type=EventType.SCOUT_DONE),
        dropped,
        dropped,  # the same event delivered twice
        # The same job processed twice (a redelivered message): two different events.
        item(run_id, Agent.FILTER, EventType.ITEM_DROPPED, posting=other, reason="no"),
    )

    stats = (await client.get(f"/api/runs/{run_id}")).json()["stats"]
    assert (stats["discovered"], stats["dropped"], stats["in_flight"]) == (2, 1, 1)


# --- Leads -----------------------------------------------------------------------


async def test_lead_filters(client: AsyncClient) -> None:
    await record(
        client,
        filtered(),
        item("", Agent.SCORER, forwarded=False, score=SCORE),
    )

    assert (await client.get("/api/leads", params={"min_score": 80, "q": "acme"})).json()[
        "total"
    ] == 1
    assert (await client.get("/api/leads", params={"min_score": 90})).json()["total"] == 0
    assert (await client.get("/api/leads", params={"remote": "true"})).json()["total"] == 0
    assert (await client.get("/api/leads", params={"offset": -1})).status_code == 422
    assert (await client.get("/api/leads", params={"limit": 0})).status_code == 422


async def test_board_remote_flag_survives_an_unknown_extraction(client: AsyncClient) -> None:
    remote_job = JOB.model_copy(update={"remote": True})
    await record(
        client,
        filtered(remote_job),
        item("", Agent.EXTRACTOR, posting=remote_job, extracted={"remote_policy": "unknown"}),
    )

    assert (await lead(client))["remote_policy"] == "remote"
    assert (await client.get("/api/leads", params={"remote": "true"})).json()["total"] == 1


async def test_apply_needs_a_tailored_cv_first(client: AsyncClient, bus: Bus) -> None:
    await record(client, filtered())
    lead_url = f"/api/leads/{JOB.job_id}"

    assert (await client.post(f"{lead_url}/apply")).status_code == 409
    assert (await client.post(f"{lead_url}/tailor")).json()["status"] == "tailoring"
    assert (await client.post(f"{lead_url}/tailor")).status_code == 409  # double click
    await record(client, tailored())
    assert (await lead(client))["status"] == "cv_ready"

    assert (await client.post(f"{lead_url}/apply")).json()["status"] == "filling"
    assert await bus.redis.xlen(Stream.APPLY.value) == 2


@pytest.mark.parametrize(
    ("kind", "data"),
    [
        (EventType.ITEM_WAITING, {"reason": "Log in to Workday first"}),
        (EventType.ITEM_FAILED, {"error": "The agent found no application form on the page"}),
    ],
)
async def test_a_failed_fill_keeps_the_tailored_cv(
    client: AsyncClient, kind: EventType, data: dict
) -> None:
    await record(
        client,
        filtered(),
        tailored(),
        item("", Agent.APPLIER, kind, action="fill_form", **data),
    )

    found = await lead(client)
    assert found["status"] == "cv_ready"
    assert found["application"]["files"] == ["cv.pdf"]
    assert found["application"]["error"] == next(iter(data.values()))


async def test_a_failed_tailoring_is_a_failure(client: AsyncClient) -> None:
    await record(
        client,
        filtered(),
        item("", Agent.APPLIER, EventType.ITEM_FAILED, action="tailor", error="timeout"),
    )

    assert (await lead(client))["status"] == "failed"


async def test_restoring_or_resetting_keeps_the_furthest_valid_state(client: AsyncClient) -> None:
    await record(client, filtered(), tailored())
    lead_url = f"/api/leads/{JOB.job_id}"

    await client.patch(lead_url, json={"status": "skipped"})
    assert (await client.patch(lead_url, json={"status": "new"})).json()["status"] == "cv_ready"

    await client.post(f"{lead_url}/apply")  # now 'filling'; the applier is then stopped
    assert (await client.patch(lead_url, json={"status": "new"})).json()["status"] == "cv_ready"


async def test_pipeline_lists_sources_and_stages(client: AsyncClient) -> None:
    pipeline = (await client.get("/api/pipeline")).json()

    ids = [node["id"] for node in pipeline["nodes"]]
    assert ids == [
        "source:greenhouse",
        "scout",
        "filter",
        "extractor",
        "scorer",
        "researcher",
        "applier",
    ]
    assert {"source": "scout", "target": "filter"} in pipeline["edges"]


async def test_applier_events_are_listed_outside_runs(client: AsyncClient) -> None:
    await record(client, filtered(), tailored())

    events = (await client.get("/api/events", params={"agent": "applier"})).json()

    assert [event["data"]["action"] for event in events] == ["tailor"]
    assert (await client.get("/api/events", params={"agent": "scout"})).status_code == 422


# --- Files -----------------------------------------------------------------------


async def test_files_are_served_only_when_listed_and_inside_the_folder(
    client: AsyncClient, tmp_path: Path
) -> None:
    folder = tmp_path / "applications" / "2026-11-11-acme-ai-engineer"
    folder.mkdir(parents=True)
    (folder / "cv.pdf").write_bytes(b"%PDF")
    (folder / "notes.md").write_text("private")
    (tmp_path / "secret.txt").write_text("secret")
    files_url = f"/api/leads/{JOB.job_id}/files"
    await record(client, filtered(), tailored())

    assert (await client.get(f"{files_url}/cv.pdf")).content == b"%PDF"
    assert (await client.get(f"{files_url}/notes.md")).json()[
        "detail"
    ] == "No such file for this lead"

    escape = item("", Agent.APPLIER, action="tailor", application_dir="..", files=["secret.txt"])
    await record(client, escape)
    response = await client.get(f"{files_url}/secret.txt")
    assert response.status_code == 404 and b"secret" not in response.content


# --- Security --------------------------------------------------------------------


async def test_writes_from_another_site_are_refused(client: AsyncClient) -> None:
    hostile = {"Origin": "https://evil.example"}

    assert (await client.post("/api/runs", headers=hostile)).status_code == 403
    assert (
        await client.post("/api/runs", headers={"Sec-Fetch-Site": "cross-site"})
    ).status_code == 403
    assert (await client.post("/api/runs", headers=UI_ORIGIN)).status_code == 201
    assert (await client.get("/api/runs", headers=hostile)).status_code == 200  # reads are fine


async def test_unknown_host_names_are_refused(client: AsyncClient) -> None:
    response = await client.get("/api/runs", headers={"Host": "attacker.example"})

    assert response.status_code == 400


async def test_health_reports_a_stopped_consumer(client: AsyncClient) -> None:
    class Stopped:
        def done(self) -> bool:
            return True

    assert (await client.get("/api/health")).status_code == 200
    client.app.state.consumer = Stopped()  # type: ignore[attr-defined]
    assert (await client.get("/api/health")).status_code == 503


async def test_a_failed_step_is_shown_on_the_lead_until_it_succeeds(client: AsyncClient) -> None:
    await record(
        client,
        filtered(),
        item("", Agent.EXTRACTOR, EventType.ITEM_FAILED, error="timed out"),
    )
    assert (await lead(client))["pipeline_error"] == {"agent": "extractor", "error": "timed out"}

    await record(client, item("", Agent.EXTRACTOR, extracted={"remote_policy": "remote"}))
    assert (await lead(client))["pipeline_error"] is None


async def test_applier_cost_is_kept_on_the_lead(client: AsyncClient) -> None:
    session = item(
        "", Agent.APPLIER, action="tailor", application_dir="d", files=["cv.pdf"], cost_usd=1.25
    )
    await record(client, filtered(), session)

    assert (await lead(client))["application"]["cost_usd"] == 1.25


async def test_an_older_database_is_upgraded_in_place(tmp_path: Path) -> None:
    from orchestrator_service.db import upgrade_schema
    from sqlalchemy import create_engine, inspect, text

    engine = create_engine(f"sqlite:///{tmp_path}/old.db")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE events (seq INTEGER PRIMARY KEY, id VARCHAR(32), ts DATETIME,"
                " run_id VARCHAR(32), agent VARCHAR(24), type VARCHAR(24), job_id VARCHAR(16),"
                " title VARCHAR(160), duration_ms INTEGER, data JSON)"
            )
        )
        connection.execute(text("CREATE TABLE leads (job_id VARCHAR(16) PRIMARY KEY)"))
        connection.execute(
            text(
                "INSERT INTO events VALUES (1, 'e1', '2026-11-11 10:00:00', 'r', 'filter',"
                " 'item.dropped', 'j1', '', NULL, '{}')"
            )
        )
        upgrade_schema(connection)
        ended = connection.execute(text("SELECT ends_job FROM events")).scalar()
        lead_columns = {c["name"] for c in inspect(connection).get_columns("leads")}

    assert ended == 1
    assert "pipeline_error" in lead_columns


async def test_a_database_outage_is_waited_out_not_skipped(monkeypatch) -> None:
    from orchestrator_service import event_log
    from sqlalchemy.exc import DBAPIError

    monkeypatch.setattr(event_log, "MAX_DB_RETRY_DELAY_S", 0)
    monkeypatch.setattr(event_log.asyncio, "sleep", _no_sleep)
    attempts = 0

    class Session:
        async def __aenter__(self) -> "Session":
            return self

        async def __aexit__(self, *exc: object) -> None:
            return None

        async def commit(self) -> None:
            return None

    async def record(session: object, event: Event) -> bool:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise DBAPIError("INSERT", {}, Exception("the database system is starting up"))
        return False

    monkeypatch.setattr(event_log, "record_event", record)

    stored = await event_log.store(lambda: Session(), item("", Agent.FILTER))

    assert (stored, attempts) == (False, 2)


async def _no_sleep(seconds: float) -> None:
    return None
