"""The pipeline as a graph, served to the UI so the picture always matches the backend."""

from __future__ import annotations

from typing import Literal

from leadscout_common.config import agent_config
from leadscout_common.schemas import Agent, GraphShape, Settings, SourceInfo
from pydantic import BaseModel

NodeKind = Literal["source", "tool", "llm", "deep", "human", "store"]


class PipelineNode(BaseModel):
    id: str
    label: str
    kind: NodeKind
    description: str
    model: str = ""
    parent: str | None = None
    enabled: bool = True
    # Agents only. How many workers the agent has: one per row of the pipeline.
    workers: int = 1
    # The agent's LangGraph graph, as the agent itself published it; None for an agent
    # that is not a graph (it has `steps` instead) or has not started yet.
    graph: GraphShape | None = None
    steps: list[str] = []


class PipelineEdge(BaseModel):
    source: str
    target: str


class Pipeline(BaseModel):
    nodes: list[PipelineNode]
    edges: list[PipelineEdge]


# (agent, label, kind, description) in pipeline order.
STAGES: list[tuple[Agent, str, NodeKind, str]] = [
    (
        Agent.SCOUT,
        "Scout",
        "tool",
        "Pulls postings from every enabled source and drops ones already seen.",
    ),
    (
        Agent.FILTER,
        "Filter",
        "tool",
        "Keeps target roles only: title keywords first, embedding similarity for the rest.",
    ),
    (
        Agent.EXTRACTOR,
        "Extractor",
        "llm",
        "Reads the posting into structured facts: skills, seniority, salary, remote policy.",
    ),
    (
        Agent.SCORER,
        "Scorer",
        "llm",
        "Scores the job against your CV and preferences, 0 to 100, with reasons.",
    ),
    (
        Agent.RESEARCHER,
        "Researcher",
        "deep",
        "Deep agent that searches the web for a sourced company brief. Top leads only.",
    ),
    (
        Agent.APPLIER,
        "Applier",
        "human",
        "On your approval: tailors the CV with polishmycv, fills the form, stops before Submit.",
    ),
]
APPLIER_MODEL = "Claude Code (headless)"
# What the agents that are not LangGraph graphs do, in order (shown when a node is expanded).
FIXED_STEPS: dict[Agent, list[str]] = {
    Agent.SCOUT: ["Fetch every enabled source", "Rank postings", "Forward the new ones"],
    Agent.FILTER: ["Title keywords", "Title embedding", "Posting text"],
    Agent.APPLIER: ["Tailor CV (polishmycv)", "Fill the form", "Stop before Submit"],
}
# One at a time on purpose: the scout runs a whole source list, the applier one application.
SINGLE_WORKER = {Agent.SCOUT, Agent.APPLIER}


def build_pipeline(
    catalogue: list[SourceInfo], settings: Settings, graphs: dict[str, GraphShape] | None = None
) -> Pipeline:
    nodes = [
        PipelineNode(
            id=f"source:{source.name}",
            label=source.label,
            kind="source",
            description="Scraped source: off unless ENABLE_SCRAPED_SOURCES=true."
            if source.scraped
            else "Job source.",
            parent=Agent.SCOUT.value,
            enabled=settings.sources.get(source.name, False),
        )
        for source in catalogue
    ]
    edges = [PipelineEdge(source=node.id, target=Agent.SCOUT.value) for node in nodes]

    for agent, label, kind, description in STAGES:
        model = APPLIER_MODEL if agent == Agent.APPLIER else agent_config(agent.value).model
        nodes.append(
            PipelineNode(
                id=agent.value,
                label=label,
                kind=kind,
                description=description,
                model=model,
                workers=1 if agent in SINGLE_WORKER else settings.workers,
                graph=(graphs or {}).get(agent.value),
                steps=FIXED_STEPS.get(agent, []),
            )
        )
    stage_ids = [agent.value for agent, *_ in STAGES]
    edges += [
        PipelineEdge(source=a, target=b) for a, b in zip(stage_ids, stage_ids[1:], strict=False)
    ]
    return Pipeline(nodes=nodes, edges=edges)
