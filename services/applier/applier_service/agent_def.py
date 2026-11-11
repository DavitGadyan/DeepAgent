"""The job-applier subagent, taken from its Claude Code definition file.

`.claude/agents/job-applier.md` is the single source of the agent's instructions. The
form-filling session runs in restricted mode from the application folder, where project
files are not loaded, so the definition is handed to it explicitly with `--agents`.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from .settings import REPO_ROOT

AGENT_NAME = "job-applier"
AGENT_FILE = REPO_ROOT / ".claude" / "agents" / f"{AGENT_NAME}.md"


def load_agent(path: Path = AGENT_FILE) -> dict[str, str]:
    """Description and prompt of the subagent.

    The file's `tools` list is left out on purpose: the session's own tool allowlist is
    stricter, and a `tools` list here would also hide the structured-report tool.
    """
    _, front_matter, body = path.read_text().split("---", 2)
    meta = yaml.safe_load(front_matter)
    return {"description": str(meta["description"]), "prompt": body.strip()}


def write_agents_file(folder: Path) -> Path:
    """Write the `--agents` file for one session into the application folder."""
    path = folder / ".agents.json"
    path.write_text(json.dumps({AGENT_NAME: load_agent()}, indent=2))
    return path
