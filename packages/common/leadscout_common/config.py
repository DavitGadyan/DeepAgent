"""Configuration: defaults live in `config/*.toml|yaml`, environment variables override."""

from __future__ import annotations

import os
import tomllib
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel


def config_dir() -> Path:
    return Path(os.environ.get("LEADSCOUT_CONFIG_DIR", "config"))


def redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://localhost:6379/0")


def ollama_base_url() -> str:
    return os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")


class AgentConfig(BaseModel):
    """Per-agent model settings from `config/agents.toml`."""

    model: str = ""
    num_ctx: int = 8192
    temperature: float = 0.0
    timeout_s: int = 300
    # Free-form extras such as thresholds; each agent documents its own keys.
    options: dict[str, Any] = {}


@lru_cache
def _agents_file() -> dict[str, Any]:
    path = config_dir() / "agents.toml"
    return tomllib.loads(path.read_text()) if path.exists() else {}


def agent_config(name: str) -> AgentConfig:
    """Settings for one agent from `agents.toml`, with environment overrides.

    Each setting is looked up as `<NAME>_<SETTING>` first (for example RESEARCHER_NUM_CTX),
    then as the shared `LEADSCOUT_<SETTING>`, then in the file. The shared LEADSCOUT_MODEL
    applies to chat agents only: an agent without a model, or an embedding agent, keeps its
    own. `min_num_ctx` in the file is a floor no override can go below (the researcher's
    fixed prompt does not fit a small window).
    """
    raw = dict(_agents_file().get("agents", {}).get(name, {}))
    known = {
        key: raw.pop(key) for key in ("model", "num_ctx", "temperature", "timeout_s") if key in raw
    }
    config = AgentConfig(**known, options=raw)

    uses_chat_model = bool(config.model) and not config.options.get("embedding")
    if model := _override(name, "MODEL", shared=uses_chat_model):
        config.model = model
    if num_ctx := _override(name, "NUM_CTX"):
        config.num_ctx = max(int(num_ctx), int(config.options.get("min_num_ctx", 0)))
    if timeout_s := _override(name, "TIMEOUT_S"):
        config.timeout_s = int(timeout_s)
    return config


def _override(name: str, setting: str, shared: bool = True) -> str | None:
    own = os.environ.get(f"{name.upper()}_{setting}")
    return own or (os.environ.get(f"LEADSCOUT_{setting}") if shared else None)


def load_yaml(name: str) -> Any:
    """Read `config/<name>`; a missing file is an empty mapping."""
    path = config_dir() / name
    return yaml.safe_load(path.read_text()) if path.exists() else {}
