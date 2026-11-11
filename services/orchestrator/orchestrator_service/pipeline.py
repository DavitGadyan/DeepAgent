"""The pipeline as a graph, served to the UI so the picture always matches the backend."""

from __future__ import annotations

from typing import Literal

from leadscout_common.config import agent_config
from leadscout_common.schemas import Agent, Settings, SourceInfo
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


def build_pipeline(catalogue: list[SourceInfo], settings: Settings) -> Pipeline:
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
                id=agent.value, label=label, kind=kind, description=description, model=model
            )
        )
    stage_ids = [agent.value for agent, *_ in STAGES]
    edges += [
        PipelineEdge(source=a, target=b) for a, b in zip(stage_ids, stage_ids[1:], strict=False)
    ]
    return Pipeline(nodes=nodes, edges=edges)
