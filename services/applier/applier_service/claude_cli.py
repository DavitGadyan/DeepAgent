"""Runs Claude Code headless (`claude --print`) and returns its result."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from leadscout_common.tracing import observe

log = logging.getLogger(__name__)


class ClaudeError(RuntimeError):
    """Claude Code did not finish the task. `cost_usd` is what the session cost anyway."""

    def __init__(self, message: str, cost_usd: float | None = None) -> None:
        super().__init__(message)
        self.cost_usd = cost_usd


@dataclass(frozen=True)
class ClaudeResult:
    text: str
    structured: dict[str, Any] | None
    # What the session would cost at API prices, as Claude Code reports it.
    cost_usd: float | None = None
    usage: dict[str, int] | None = None
    # Tools the session asked for and was refused (not on the allowlist).
    denied_tools: list[str] = field(default_factory=list)


async def run_claude(
    claude_bin: str,
    prompt: str,
    cwd: Path,
    allowed_tools: list[str],
    timeout_s: int,
    trace_name: str,
    job_id: str,
    max_budget_usd: float | None = None,
    extra_args: list[str] | None = None,
    env: dict[str, str] | None = None,
    access: str = "login",
    api_key: str | None = None,
    model: str = "",
) -> ClaudeResult:
    """One headless Claude Code session. Only `allowed_tools` may run; anything else is denied.

    `access` picks how it signs in: "login" (your Claude account) or "console" (API key).
    `model` is an alias or full model name; empty leaves Claude Code's default.

    The session is recorded in Langfuse (when configured) with its token usage and cost.
    """
    command = [claude_bin, "--print", "--output-format", "json", "--allowedTools", *allowed_tools]
    if max_budget_usd:
        command += ["--max-budget-usd", f"{max_budget_usd:g}"]
    if model:
        command += ["--model", model]
    command += extra_args or []
    session = session_env(env, access, api_key)  # first: a missing key is a setup error

    with observe(
        trace_name,
        "generation",
        f"claude-code:{model or 'default'}",
        prompt,
        f"lead-{job_id}",
        ["applier"],
    ) as observation:
        try:
            result = await _run(command, prompt, cwd, timeout_s, session)
        except ClaudeError as error:
            observation.record(error=str(error))
            raise
        observation.record(output=result.text, usage=result.usage, cost_usd=result.cost_usd)
    if result.denied_tools:
        log.warning("%s: tools refused by the allowlist: %s", trace_name, result.denied_tools)
    return result


# What a session needs from this process's environment. Everything else (database
# password, tracing keys, other .env values) stays out of reach of the session.
PASSED_ENV = {
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TERM",
}
PASSED_PREFIXES = ("ANTHROPIC_", "CLAUDE_")
# Claude Code prefers these over your account login when they are set.
API_CREDENTIALS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def session_env(
    extra: dict[str, str] | None = None, access: str = "login", api_key: str | None = None
) -> dict[str, str]:
    """The session's environment for the chosen sign-in.

    login:   API credentials are removed, so the session uses your Claude account and
             cannot bill a Console key you happen to have in `.env`.
    console: the key (`api_key`, else `ANTHROPIC_API_KEY`) must be set; the session is
             billed to it.
    """
    passed = {
        name: value
        for name, value in os.environ.items()
        if name in PASSED_ENV or name.startswith(PASSED_PREFIXES)
    }
    if access == "console":
        key = api_key or passed.get("ANTHROPIC_API_KEY")
        if not key:
            raise ClaudeError(
                "Claude access is set to Console API key, but ANTHROPIC_API_KEY is not set. "
                "Add it to .env (no restart needed), or switch to Claude login on Setup."
            )
        passed["ANTHROPIC_API_KEY"] = key
    else:
        for name in API_CREDENTIALS:
            passed.pop(name, None)
    return {**passed, **(extra or {})}


async def _run(
    command: list[str], prompt: str, cwd: Path, timeout_s: int, env: dict[str, str]
) -> ClaudeResult:
    log.info("Starting Claude Code in %s", cwd)
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,  # its own process group, so a timeout can stop its children too
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(prompt.encode()), timeout_s)
    except TimeoutError:
        _stop_process_group(process)
        await process.wait()
        raise ClaudeError(f"Claude Code exceeded its {timeout_s}s budget and was stopped") from None
    except asyncio.CancelledError:
        _stop_process_group(process)
        raise
    return parse_result(stdout.decode(), stderr.decode(), process.returncode or 0)


def _stop_process_group(process: asyncio.subprocess.Process) -> None:
    """Kill the session and everything it started (MCP servers, scripts). Chrome is not ours."""
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)


def parse_result(stdout: str, stderr: str, return_code: int) -> ClaudeResult:
    """Read the `--output-format json` envelope; raise `ClaudeError` on any failure."""
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError:
        detail = (stderr or stdout).strip()[-400:]
        raise ClaudeError(f"Claude Code exited with code {return_code}: {detail}") from None
    if return_code != 0 or envelope.get("is_error"):
        reason = envelope.get("result") or envelope.get("subtype") or "unknown error"
        raise ClaudeError(str(reason)[:400], cost_usd=envelope.get("total_cost_usd"))
    return ClaudeResult(
        text=str(envelope.get("result", "")),
        structured=envelope.get("structured_output"),
        cost_usd=envelope.get("total_cost_usd"),
        usage=token_usage(envelope.get("usage") or {}),
        denied_tools=sorted(
            {str(d.get("tool_name", "?")) for d in envelope.get("permission_denials") or []}
        ),
    )


def token_usage(usage: dict[str, Any]) -> dict[str, int]:
    """Claude Code's usage block as flat token counts (Langfuse `usage_details`)."""
    return {
        "input": usage.get("input_tokens", 0),
        "output": usage.get("output_tokens", 0),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
    }
