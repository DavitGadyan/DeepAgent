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
        connection.execute(text("INSERT INTO leads VALUES ('j1')"))
        connection.execute(
            text(
                "INSERT INTO events VALUES (1, 'e1', '2026-11-11 10:00:00', 'r', 'filter',"
                " 'item.dropped', 'j1', '', NULL, '{}')"
            )
        )
        upgrade_schema(connection)
        ended = connection.execute(text("SELECT ends_job FROM events")).scalar()
        lead_columns = {c["name"] for c in inspect(connection).get_columns("leads")}
        found = connection.execute(text("SELECT created_at FROM leads")).scalar()

    assert ended == 1
    assert "pipeline_error" in lead_columns
    assert str(found).startswith("2026-11-11 10:00:00")  # found when its first event was stored


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


async def test_profile_is_saved_to_the_file_and_read_back(
    client: AsyncClient, tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "profile" / "profile.yaml"
    monkeypatch.setenv("PROFILE_PATH", str(path))
    path.parent.mkdir()
    path.write_text("application:\n  years_of_experience: 7\n  pronouns: they/them\n")

    stored = (await client.get("/api/profile")).json()
    assert stored["application"]["years_of_experience"] == "7"  # a YAML number becomes text
    stored["preferences"]["remote"] = "remote only"
    saved = await client.put("/api/profile", json=stored, headers=UI_ORIGIN)

    assert saved.status_code == 200
    text = path.read_text()
    assert "remote: remote only" in text
    assert "pronouns: they/them" in text  # a key added by hand is kept
    assert (await client.get("/api/profile")).json()["preferences"]["remote"] == "remote only"


async def test_profile_write_from_another_site_is_refused(
    client: AsyncClient, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("PROFILE_PATH", str(tmp_path / "profile.yaml"))
    answer = await client.put("/api/profile", json={}, headers={"Origin": "https://evil.example"})

    assert answer.status_code == 403
    assert not (tmp_path / "profile.yaml").exists()


async def test_claude_access_and_budgets_are_settings(client: AsyncClient, bus: Bus) -> None:
    settings = (await client.get("/api/settings")).json()
    assert settings["claude_access"] == "login"
    settings.update(claude_access="console", fill_budget_usd=2.5)

    assert (await client.put("/api/settings", json=settings, headers=UI_ORIGIN)).status_code == 200
    mirrored = await load_settings(bus)
    assert (mirrored.claude_access, mirrored.fill_budget_usd) == ("console", 2.5)
    settings["claude_access"] = "both"
    assert (await client.put("/api/settings", json=settings, headers=UI_ORIGIN)).status_code == 422


async def test_applier_status_is_null_until_the_worker_reports(
    client: AsyncClient, bus: Bus
) -> None:
    from leadscout_common.schemas import ApplierStatus
    from leadscout_common.shared_state import save_applier_status

    assert (await client.get("/api/applier")).json() is None
    await save_applier_status(bus, ApplierStatus(logged_in=True, auth_method="claude.ai"))

    assert (await client.get("/api/applier")).json()["logged_in"] is True


# --- Workers, graphs and progress ----------------------------------------------------


async def test_workers_chosen_at_start_stay_for_the_agents(client: AsyncClient, bus: Bus) -> None:
    run = (await client.post("/api/runs", json={"workers": 3}, headers=UI_ORIGIN)).json()

    assert run["options"]["workers"] == 3
    assert (await load_settings(bus)).workers == 3
    nodes = {node["id"]: node for node in (await client.get("/api/pipeline")).json()["nodes"]}
    assert (nodes["extractor"]["workers"], nodes["applier"]["workers"]) == (3, 1)

    later = (await client.post("/api/runs", json={}, headers=UI_ORIGIN)).json()
    assert later["options"]["workers"] == 3  # not given: the count stays


async def test_pipeline_shows_each_agents_graph_or_steps(client: AsyncClient, bus: Bus) -> None:
    from leadscout_common.schemas import GraphEdge, GraphNode, GraphShape
    from leadscout_common.shared_state import save_graph

    shape = GraphShape(
        nodes=[GraphNode(id="facts", label="facts"), GraphNode(id="tidy", label="tidy")],
        edges=[GraphEdge(source="facts", target="tidy")],
    )
    await save_graph(bus, "extractor", shape)

    nodes = {node["id"]: node for node in (await client.get("/api/pipeline")).json()["nodes"]}

    assert nodes["extractor"]["graph"]["edges"] == [
        {"source": "facts", "target": "tidy", "conditional": False}
    ]
    assert nodes["scorer"]["graph"] is None  # that agent has not started yet
    assert nodes["filter"]["steps"] == ["Title keywords", "Title embedding", "Posting text"]


async def test_progress_inside_an_agent_changes_no_statistics(client: AsyncClient) -> None:
    run_id = (await client.post("/api/runs", headers=UI_ORIGIN)).json()["id"]
    await record(client, item(run_id, Agent.SCOUT), filtered(run_id=run_id))
    before = (await client.get(f"/api/runs/{run_id}")).json()["stats"]

    step = item(run_id, Agent.EXTRACTOR, EventType.ITEM_PROGRESS, node="facts", worker=2)
    await record(client, step)

    assert (await client.get(f"/api/runs/{run_id}")).json()["stats"] == before
    stored = (await client.get(f"/api/runs/{run_id}/events")).json()
    assert stored[-1]["data"] == {"node": "facts", "worker": 2}  # kept for the replay


# --- Leads: found date, sort, live push ---------------------------------------------


async def test_leads_are_newest_first_and_filter_on_the_found_date(client: AsyncClient) -> None:
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    old_job = JOB.model_copy(update={"title": "Old ML Engineer"})
    old = filtered(old_job)
    old.ts = now - timedelta(days=5)
    await record(client, old, item("", Agent.SCORER, posting=old_job, score=SCORE))
    await record(client, filtered())  # found now, not scored yet

    newest = (await client.get("/api/leads")).json()["items"]
    assert [lead["title"] for lead in newest] == ["AI Engineer", "Old ML Engineer"]
    by_score = (await client.get("/api/leads", params={"sort": "score"})).json()["items"]
    assert [lead["title"] for lead in by_score] == ["Old ML Engineer", "AI Engineer"]

    day_ago = (now - timedelta(days=1)).isoformat()
    recent = (await client.get("/api/leads", params={"found_after": day_ago})).json()
    assert [lead["title"] for lead in recent["items"]] == ["AI Engineer"]
    older = (await client.get("/api/leads", params={"found_before": day_ago})).json()
    assert [lead["title"] for lead in older["items"]] == ["Old ML Engineer"]


async def test_a_changed_lead_is_pushed_to_open_pages(client: AsyncClient) -> None:
    from orchestrator_service import event_log

    app = client.app  # type: ignore[attr-defined]
    queue = app.state.broadcaster.subscribe()
    await record(client, filtered())

    started = item("", Agent.EXTRACTOR, EventType.ITEM_STARTED)
    scored = item("", Agent.SCORER, score=SCORE)
    assert not event_log.may_change_lead(started)  # nothing on the lead changed
    await record(client, scored)
    await event_log.push_lead(app.state.sessions, app.state.broadcaster, JOB.job_id)

    pushed = queue.get_nowait()
    assert isinstance(pushed, event_log.LeadChanged)
    assert (pushed.lead["score"], pushed.lead["status"]) == (82, "scored")

    await client.patch(f"/api/leads/{JOB.job_id}", json={"status": "skipped"}, headers=UI_ORIGIN)
    assert queue.get_nowait().lead["status"] == "skipped"  # your own changes are pushed too


# --- Costs ----------------------------------------------------------------------------


def session_event(usd: float, **data: object) -> Event:
    return item("", Agent.APPLIER, action="tailor", cost_usd=usd, forwarded=False, **data)


async def test_costs_are_split_by_who_pays_and_include_failed_sessions(
    client: AsyncClient,
) -> None:
    failed = item("", Agent.APPLIER, EventType.ITEM_FAILED, action="fill_form", cost_usd=0.5)
    await record(
        client,
        filtered(),
        session_event(3.0),  # before the switch existed: Claude login
        session_event(2.0, access="console", model="opus"),
        failed,
        item("", Agent.APPLIER, EventType.ITEM_STARTED, action="tailor"),  # no cost: not counted
    )

    report = (await client.get("/api/costs", params={"days": 7})).json()

    assert report["all_time"] == {"usd": 5.5, "billed_usd": 2.0, "sessions": 3}
    assert report["today"]["usd"] == 5.5
    assert len(report["by_day"]) == 7
    assert report["by_day"][-1] == {
        "date": report["by_day"][-1]["date"],
        "login_usd": 3.5,
        "console_usd": 2.0,
    }
    assert [(row["key"], row["usd"]) for row in report["by_action"]] == [
        ("tailor", 5.0),
        ("fill_form", 0.5),
    ]
    assert {row["key"] for row in report["by_model"]} == {"default", "opus"}
    assert report["top_leads"] == [{"job_id": JOB.job_id, "title": "", "usd": 5.5, "sessions": 3}]
    assert report["links"]["console_billing"].startswith("https://console.anthropic.com")
    lead = (await client.get(f"/api/leads/{JOB.job_id}")).json()
    assert lead["application"]["cost_usd"] == 5.5  # the failed session is on the lead too


async def test_a_used_up_monthly_budget_stops_new_sessions(client: AsyncClient) -> None:
    await record(client, filtered(), session_event(4.0))
    settings = (await client.get("/api/settings")).json()
    settings["monthly_budget_usd"] = 4
    await client.put("/api/settings", json=settings, headers=UI_ORIGIN)

    refused = await client.post(f"/api/leads/{JOB.job_id}/tailor", headers=UI_ORIGIN)
    assert refused.status_code == 409
    assert "monthly budget" in refused.json()["detail"]

    settings["monthly_budget_usd"] = 10
    await client.put("/api/settings", json=settings, headers=UI_ORIGIN)
    assert (
        await client.post(f"/api/leads/{JOB.job_id}/tailor", headers=UI_ORIGIN)
    ).status_code == 202


# --- Stopping a run ---------------------------------------------------------------------


async def test_a_stopped_run_is_marked_and_the_agents_are_told(
    client: AsyncClient, bus: Bus
) -> None:
    from leadscout_common.shared_state import run_stopped

    run_id = (await client.post("/api/runs", headers=UI_ORIGIN)).json()["id"]
    await record(client, item(run_id, Agent.SCOUT), filtered(run_id=run_id))

    stopped = await client.post(f"/api/runs/{run_id}/stop", headers=UI_ORIGIN)

    assert stopped.status_code == 200
    assert stopped.json()["status"] == "stopped"
    assert stopped.json()["finished_at"] is not None
    assert await run_stopped(bus, run_id)
    assert not await run_stopped(bus, "another-run")

    # An agent lets go of the job that was waiting: the counts settle, the run stays stopped.
    let_go = item(run_id, Agent.EXTRACTOR, EventType.ITEM_DROPPED, reason="The run was stopped")
    await record(client, let_go, Event(run_id=run_id, agent=Agent.SCOUT, type=EventType.SCOUT_DONE))
    after = (await client.get(f"/api/runs/{run_id}")).json()
    assert (after["status"], after["stats"]["in_flight"]) == ("stopped", 0)

    again = await client.post(f"/api/runs/{run_id}/stop", headers=UI_ORIGIN)
    # Nothing changes (SQLite hands the time back without its zone, hence the prefix).
    assert again.json()["finished_at"][:26] == stopped.json()["finished_at"][:26]
    assert (await client.post("/api/runs/nope/stop", headers=UI_ORIGIN)).status_code == 404
