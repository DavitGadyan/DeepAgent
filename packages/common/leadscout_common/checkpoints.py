"""LangGraph checkpoints in Postgres: a job that was cut off continues where it stopped.

Each graph agent (extractor, scorer, researcher) runs one job as one LangGraph thread and
saves its state after every node. The thread id is `<job id>/<agent>`: the job id is the
id the UI shows, and the agent suffix keeps three different graphs from overwriting each
other. The tables are LangGraph's own, in the Postgres the stack already runs; the agents
write nothing else there.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .retry import is_transient, is_unreachable
from .schemas import GraphEdge, GraphNode, GraphShape
from .tracing import langchain_config
from .worker import report_progress

log = logging.getLogger(__name__)
START, END = "__start__", "__end__"


def thread_id(job_id: str, agent: str) -> str:
    return f"{job_id}/{agent}"


async def open_checkpointer(pool_size: int = 4) -> Any | None:
    """The Postgres checkpointer for `CHECKPOINT_DB_URL`, or None when it is not set.

    Without it the graphs still run; a job that is cut off then starts again from its
    first node (Redis redelivers it).
    """
    url = os.environ.get("CHECKPOINT_DB_URL", "")
    if not url:
        log.warning("CHECKPOINT_DB_URL is not set: jobs are not checkpointed")
        return None
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    pool = AsyncConnectionPool(
        url,
        min_size=1,
        max_size=pool_size,
        open=False,
        # What the saver needs. No prepared statements, so a pooler in front of the
        # database (PgBouncer in transaction mode) works too.
        kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None},
    )
    await pool.open(wait=True, timeout=30)
    saver = AsyncPostgresSaver(pool)
    await _create_tables(saver)
    log.info("Checkpoints are stored in Postgres")
    return saver


async def _create_tables(saver: Any, attempts: int = 5) -> None:
    """Create the checkpoint tables on first start; a no-op afterwards.

    Three agents start at the same moment and each tries to create the same tables. The
    ones that lose that race get a "duplicate" error from Postgres and only need to try
    again: by then the tables exist.
    """
    import asyncio

    from psycopg import errors

    lost_the_race = (errors.UniqueViolation, errors.DuplicateTable, errors.DuplicateObject)
    for attempt in range(1, attempts + 1):
        try:
            await saver.setup()
            return
        except lost_the_race:
            if attempt == attempts:
                raise
            await asyncio.sleep(0.5 * attempt)


async def run_thread(
    graph: Any,
    thread: str,
    state: dict[str, Any],
    recursion_limit: int | None = None,
) -> dict[str, Any]:
    """Run `graph` for one job and return its final state.

    - A saved thread with unfinished nodes continues from there; nodes that finished
      before the stop do not run again.
    - No saved thread, or a finished one (the job is processed again on purpose), starts
      from `state`.
    - A failure that a retry cannot fix removes the thread, so a later run does not
      repeat a bad state. A transient one keeps it, and the retry continues from it.

    Each node that starts is reported to the UI (`item.progress`).
    """
    config: dict[str, Any] = {"configurable": {"thread_id": thread}, **langchain_config()}
    if recursion_limit:
        config["recursion_limit"] = recursion_limit
    resuming = await _unfinished_node(graph, config, thread)
    final: dict[str, Any] = {}
    try:
        stream = graph.astream(None if resuming else state, config, stream_mode=["tasks", "values"])
        async for mode, chunk in stream:
            if mode == "values":
                final = chunk
            elif "result" not in chunk:  # a task that starts (a finished one has a result)
                await report_progress(chunk["name"], resumed=chunk["name"] == resuming)
                resuming = None
    except Exception as error:
        if not (is_transient(error) or is_unreachable(error)):
            await forget_thread(graph, thread)
        raise
    return final


async def _unfinished_node(graph: Any, config: dict[str, Any], thread: str) -> str | None:
    """The node a saved thread stopped at, or None for a fresh start (old state removed)."""
    if graph.checkpointer is None:
        return None
    snapshot = await graph.aget_state(config)
    if snapshot.next:
        log.info("Thread %s continues at %s", thread, snapshot.next[0])
        return str(snapshot.next[0])
    if snapshot.created_at:
        await forget_thread(graph, thread)
    return None


async def forget_thread(graph: Any, thread: str) -> None:
    if graph.checkpointer is not None:
        await graph.checkpointer.adelete_thread(thread)


def graph_shape(graph: Any) -> GraphShape:
    """Nodes and edges of a compiled graph, for the UI.

    Middleware hooks of an agent graph (names such as `X.before_agent`) are plumbing: they
    are left out and the edges through them are joined.
    """
    drawn = graph.get_graph()
    hidden = {name for name in drawn.nodes if "." in name}
    follow: dict[str, list[tuple[str, bool]]] = {}
    for edge in drawn.edges:
        follow.setdefault(edge.source, []).append((edge.target, bool(edge.conditional)))

    def visible_targets(node: str, seen: frozenset[str]) -> list[tuple[str, bool]]:
        found = []
        for target, conditional in follow.get(node, []):
            if target not in hidden:
                found.append((target, conditional))
            elif target not in seen:
                found += visible_targets(target, seen | {target})
        return found

    edges: dict[tuple[str, str], bool] = {}
    for source in drawn.nodes:
        if source in hidden:
            continue
        for target, conditional in visible_targets(source, frozenset()):
            if target != source:
                edges[(source, target)] = edges.get((source, target), False) or conditional
    return GraphShape(
        nodes=[
            GraphNode(id=name, label=_label(name)) for name in drawn.nodes if name not in hidden
        ],
        edges=[
            GraphEdge(source=source, target=target, conditional=conditional)
            for (source, target), conditional in edges.items()
        ],
    )


def _label(name: str) -> str:
    return {START: "Start", END: "End"}.get(name, name.replace("_", " "))
