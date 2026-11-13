"""Applier configuration, all from the environment (see `.env.example`)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


@dataclass(frozen=True)
class ApplierSettings:
    claude_bin: str
    polishmycv_home: Path
    skill_dir: Path
    profile_path: Path
    chrome_bin: str
    chrome_profile_dir: Path
    cdp_port: int
    tailor_timeout_s: int
    fill_timeout_s: int
    # Caps on what one Claude Code session may spend (`--max-budget-usd`); 0 means no cap.
    # Set on the Setup page; these are only the values before the first save.
    tailor_budget_usd: float
    fill_budget_usd: float
    # A button press older than this when the applier sees it is not acted on.
    max_command_age_s: int
    # "login" (your Claude account) or "console" (ANTHROPIC_API_KEY); set on the Setup page.
    claude_access: str = "login"
    # Model for Tailor CV ("" = Claude Code's default); set on the Setup page.
    tailor_model: str = ""
    # The Console key, read from `env_file` for each command (see `read_api_key`).
    api_key: str = field(default="", repr=False)
    env_file: Path = REPO_ROOT / ".env"

    @property
    def output_root(self) -> Path:
        """polishmycv writes one folder per application here."""
        return self.polishmycv_home / "output"

    @property
    def scripts_dir(self) -> Path:
        return self.skill_dir / "scripts"

    @property
    def cdp_url(self) -> str:
        return f"http://127.0.0.1:{self.cdp_port}"


def read_api_key(env_file: Path) -> str:
    """`ANTHROPIC_API_KEY` as `.env` says now, so adding it there needs no restart.

    A key only in the environment the worker started with (exported in the shell) is the
    fallback.
    """
    found: str | None = None
    try:
        lines = env_file.read_text().splitlines()
    except OSError:
        lines = []
    for line in lines:
        name, equals, value = line.strip().removeprefix("export ").partition("=")
        if equals and name.strip() == "ANTHROPIC_API_KEY":
            found = _env_value(value)  # the last one wins, as in the shell
    return found if found else os.environ.get("ANTHROPIC_API_KEY", "")


def _env_value(raw: str) -> str:
    """`"sk-..."  # note` -> sk-...: quotes removed, a trailing comment ignored."""
    value = raw.strip()
    if value[:1] in ("'", '"'):
        closing = value.find(value[0], 1)
        return value[1:closing] if closing > 0 else value[1:]
    return value.split(" #", 1)[0].strip()


def _path(name: str, default: str | Path) -> Path:
    return Path(os.environ.get(name, str(default))).expanduser()


def load_settings() -> ApplierSettings:
    env = os.environ
    return ApplierSettings(
        claude_bin=env.get("CLAUDE_BIN", "claude"),
        polishmycv_home=_path("POLISHMYCV_HOME", "~/Desktop/Github/polishmycv"),
        # Resolved, because permission rules compare real paths.
        skill_dir=_path("POLISHMYCV_SKILL_DIR", "~/.claude/skills/polishmycv").resolve(),
        profile_path=_path("PROFILE_PREFS_PATH", REPO_ROOT / "data/profile/profile.yaml"),
        chrome_bin=env.get("CHROME_BIN", DEFAULT_CHROME),
        chrome_profile_dir=_path("APPLIER_CHROME_PROFILE", "~/.leadscout/chrome-profile"),
        cdp_port=int(env.get("APPLIER_CDP_PORT", "9333")),
        tailor_timeout_s=int(env.get("APPLIER_TAILOR_TIMEOUT_S", "3600")),
        fill_timeout_s=int(env.get("APPLIER_FILL_TIMEOUT_S", "900")),
        tailor_budget_usd=10,
        fill_budget_usd=5,
        max_command_age_s=int(env.get("APPLIER_MAX_COMMAND_AGE_S", "900")),
        env_file=_path("LEADSCOUT_ENV_FILE", REPO_ROOT / ".env"),
    )
