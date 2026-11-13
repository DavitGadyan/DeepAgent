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


# --- Checkpoints: a job that was cut off continues at the node that did not finish ---


def _scripted_model(monkeypatch, fail_highlights_with: list[Exception]):
    """A fake model that counts calls per schema and fails `highlights` as scripted."""
    from extractor_service import main as extractor
    from leadscout_common.schemas import JobFacts, JobHighlights

    calls = {"facts": 0, "highlights": 0}

    async def fake_call(config, schema, system, user):
        if schema is JobFacts:
            calls["facts"] += 1
            return JobFacts(role_family="AI Engineer", required_skills=["Python"])
        calls["highlights"] += 1
        if fail_highlights_with:
            raise fail_highlights_with.pop(0)
        return JobHighlights(summary="Build agents.")

    monkeypatch.setattr(extractor, "structured_call", fake_call)
    return calls


async def test_a_cut_off_job_continues_at_the_unfinished_node(monkeypatch) -> None:
    import pytest
    from extractor_service import main as extractor
    from langgraph.checkpoint.memory import InMemorySaver
    from leadscout_common.config import AgentConfig

    calls = _scripted_model(monkeypatch, [ConnectionError("model server went away")])
    config = AgentConfig(model="m")
    graph = extractor.build_graph(config, InMemorySaver())

    with pytest.raises(ConnectionError):
        await extractor.extract(JOB, config, graph)
    extracted = await extractor.extract(JOB, config, graph)  # the retry, or the restart

    assert calls == {"facts": 1, "highlights": 2}  # `facts` was not paid for twice
    assert extracted.summary == "Build agents."


async def test_a_job_that_failed_for_good_starts_fresh_next_time(monkeypatch) -> None:
    import pytest
    from extractor_service import main as extractor
    from langgraph.checkpoint.memory import InMemorySaver
    from leadscout_common.config import AgentConfig

    calls = _scripted_model(monkeypatch, [ValueError("model returned nonsense")])
    config = AgentConfig(model="m")
    graph = extractor.build_graph(config, InMemorySaver())

    with pytest.raises(ValueError):
        await extractor.extract(JOB, config, graph)
    await extractor.extract(JOB, config, graph)

    assert calls == {"facts": 2, "highlights": 2}


async def test_a_finished_job_processed_again_runs_every_node(monkeypatch) -> None:
    from extractor_service import main as extractor
    from langgraph.checkpoint.memory import InMemorySaver
    from leadscout_common.config import AgentConfig

    calls = _scripted_model(monkeypatch, [])
    config = AgentConfig(model="m")
    graph = extractor.build_graph(config, InMemorySaver())

    await extractor.extract(JOB, config, graph)
    await extractor.extract(JOB, config, graph)  # a forced re-run

    assert calls == {"facts": 2, "highlights": 2}


async def test_graph_nodes_are_reported_and_the_shape_matches_the_code(monkeypatch, bus) -> None:
    from extractor_service import main as extractor
    from langgraph.checkpoint.memory import InMemorySaver
    from leadscout_common import worker as worker_module
    from leadscout_common.bus import PAYLOAD_FIELD
    from leadscout_common.checkpoints import graph_shape
    from leadscout_common.config import AgentConfig
    from leadscout_common.schemas import Agent, Event, EventType, JobMessage, Stream
    from leadscout_common.worker import StageResult, process_one

    _scripted_model(monkeypatch, [ConnectionError("gone")])
    config = AgentConfig(model="m")
    graph = extractor.build_graph(config, InMemorySaver())

    shape = graph_shape(graph)
    assert [node.id for node in shape.nodes] == [
        "__start__",
        "facts",
        "highlights",
        "tidy",
        "__end__",
    ]
    assert [(edge.source, edge.target) for edge in shape.edges] == [
        ("__start__", "facts"),
        ("facts", "highlights"),
        ("highlights", "tidy"),
        ("tidy", "__end__"),
    ]

    async def handle(message: JobMessage) -> StageResult:
        message.extracted = await extractor.extract(message.job, config, graph)
        return StageResult(message)

    # The model server is unreachable once: the worker waits and runs the job again,
    # which continues from the checkpoint.
    monkeypatch.setattr(worker_module, "FIRST_WAIT_S", 0)
    message = JobMessage(run_id="run1", job=JOB)
    await process_one(Agent.EXTRACTOR, Stream.EXTRACTED, handle, bus, message, worker=2)

    entries = await bus.redis.xrange(Stream.EVENTS.value)
    events = [Event.model_validate_json(fields[PAYLOAD_FIELD]) for _, fields in entries]
    progress = [event.data for event in events if event.type == EventType.ITEM_PROGRESS]
    assert progress == [
        {"node": "facts", "worker": 2},
        {"node": "highlights", "worker": 2},
        {"node": "highlights", "worker": 2, "resumed": True},
        {"node": "tidy", "worker": 2},
    ]
