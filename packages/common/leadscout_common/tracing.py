"""Langfuse tracing: every model call becomes a trace with its prompt, output, tokens and cost.

Off unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set (plus `LANGFUSE_BASE_URL`
for a self-hosted server). When off, every function here is a cheap no-op, so the agents
contain no "is tracing on?" branches.

How calls are grouped in Langfuse:
  session  = the pipeline run (`run_id`), or `lead-<job_id>` for applier actions
  trace    = one agent handling one job, named after the agent
  tags     = agent name and job source
  metadata = job id, title, company

The shared worker loop opens `job_context` around each job, so any model call an agent
makes while handling it is attributed automatically.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from .schemas import Agent, JobMessage


def tracing_enabled() -> bool:
    return bool(os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY"))


@contextmanager
def job_context(agent: Agent, message: JobMessage) -> Iterator[None]:
    """Attribute every call made inside the block to this run, agent and job."""
    if not tracing_enabled():
        yield
        return
    from langfuse import propagate_attributes

    with propagate_attributes(
        trace_name=agent.value,
        session_id=message.run_id or f"lead-{message.job_id}",
        tags=[agent.value, message.job.source],
        metadata={
            "job_id": message.job_id,
            "title": message.job.title[:150],
            "company": message.job.company[:100],
        },
    ):
        yield


def langchain_config() -> dict[str, Any]:
    """Config for `.ainvoke(...)` on a LangChain model or deep agent; empty when tracing is off.

    The Langfuse callback records each model call (and, for the researcher, each tool
    call) with the token counts Ollama reports.
    """
    if not tracing_enabled():
        return {}
    from langfuse.langchain import CallbackHandler

    return {"callbacks": [CallbackHandler()]}


class Observation:
    """Handle for a manually traced call. `record` is safe to call when tracing is off."""

    def __init__(self, span: Any = None) -> None:
        self._span = span

    def record(
        self,
        output: Any = None,
        usage: dict[str, int] | None = None,
        cost_usd: float | None = None,
        error: str = "",
    ) -> None:
        if self._span is None:
            return
        self._span.update(
            output=output,
            usage_details=usage,
            cost_details={"total": cost_usd} if cost_usd is not None else None,
            level="ERROR" if error else None,
            status_message=error or None,
        )


@contextmanager
def observe(
    name: str,
    kind: str,
    model: str,
    input: Any,
    session_id: str | None = None,
    tags: list[str] | None = None,
) -> Iterator[Observation]:
    """Trace a call that does not go through LangChain (embeddings, Claude Code).

    `kind` is a Langfuse observation type: "generation" or "embedding". Inside a
    `job_context` the session and tags are inherited; outside one, pass them.
    """
    if not tracing_enabled():
        yield Observation()
        return
    from langfuse import get_client, propagate_attributes

    observation = get_client().start_as_current_observation(
        name=name, as_type=kind, model=model, input=input
    )
    if session_id is None:
        with observation as span:
            yield Observation(span)
        return
    with (
        propagate_attributes(session_id=session_id, tags=tags, trace_name=name),
        observation as span,
    ):
        yield Observation(span)


def flush() -> None:
    """Send buffered traces now. Call before a short-lived process exits."""
    if tracing_enabled():
        from langfuse import get_client

        get_client().flush()
