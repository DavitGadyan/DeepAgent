"""Tracing against the real Langfuse SDK, with spans captured in memory instead of sent."""

import json

import pytest
from langchain_core.language_models import FakeListChatModel
from leadscout_common import tracing
from leadscout_common.schemas import Agent, JobMessage, JobPosting
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

MESSAGE = JobMessage(
    run_id="run-1",
    job=JobPosting(source="jobicy", url="https://x.test/1", title="AI Engineer", company="Acme"),
)


@pytest.fixture(scope="module")
def exported() -> InMemorySpanExporter:
    """One Langfuse client for the module: the SDK keeps a client per public key."""
    from langfuse import Langfuse

    exporter = InMemorySpanExporter()
    Langfuse(public_key="pk-test", secret_key="sk-test", span_exporter=exporter)
    return exporter


@pytest.fixture
def spans(exported: InMemorySpanExporter, monkeypatch: pytest.MonkeyPatch) -> InMemorySpanExporter:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test")
    exported.clear()
    return exported


def test_everything_is_a_no_op_without_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

    assert tracing.langchain_config() == {}
    with (
        tracing.job_context(Agent.SCORER, MESSAGE),
        tracing.observe("x", "generation", "m", "in") as call,
    ):
        call.record(output="out", cost_usd=1.0)  # must not raise


def test_call_outside_a_job_records_its_own_session_usage_and_cost(
    spans: InMemorySpanExporter,
) -> None:
    with tracing.observe(
        "applier.tailor", "generation", "claude-code", "prompt", "lead-abc", ["applier"]
    ) as call:
        call.record(output="done", usage={"input": 10, "output": 5}, cost_usd=0.31)
    tracing.flush()

    (span,) = spans.get_finished_spans()
    recorded = span.attributes
    assert recorded["session.id"] == "lead-abc"
    assert recorded["langfuse.trace.tags"] == ("applier",)
    assert recorded["langfuse.observation.model.name"] == "claude-code"
    assert json.loads(recorded["langfuse.observation.usage_details"]) == {"input": 10, "output": 5}
    assert json.loads(recorded["langfuse.observation.cost_details"]) == {"total": 0.31}


async def test_calls_inside_a_job_inherit_run_agent_and_job(spans: InMemorySpanExporter) -> None:
    model = FakeListChatModel(responses=["hello"])

    with tracing.job_context(Agent.EXTRACTOR, MESSAGE):
        await model.ainvoke("hi", config=tracing.langchain_config())
        with tracing.observe("filter.embed", "embedding", "bge-m3", ["AI Engineer"]) as call:
            call.record(usage={"input": 3})
    tracing.flush()

    generation, embedding = spans.get_finished_spans()
    for span in (generation, embedding):
        assert span.attributes["session.id"] == "run-1"
        assert span.attributes["langfuse.trace.tags"] == ("extractor", "jobicy")
        assert json.loads(span.attributes["langfuse.trace.metadata.job_id"]) == MESSAGE.job_id
    assert generation.attributes["langfuse.observation.type"] == "generation"
    assert embedding.attributes["langfuse.observation.type"] == "embedding"
