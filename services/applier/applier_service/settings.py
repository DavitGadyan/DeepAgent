"""Applier configuration, all from the environment (see `.env.example`)."""

from __future__ import annotations

import os
from dataclasses import dataclass
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
    tailor_budget_usd: float
    fill_budget_usd: float
    # A button press older than this when the applier sees it is not acted on.
    max_command_age_s: int

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
        tailor_budget_usd=float(env.get("APPLIER_TAILOR_BUDGET_USD", "10")),
        fill_budget_usd=float(env.get("APPLIER_FILL_BUDGET_USD", "5")),
        max_command_age_s=int(env.get("APPLIER_MAX_COMMAND_AGE_S", "900")),
    )
