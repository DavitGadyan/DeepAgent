"""Applier parts that can be tested without Claude Code or a browser."""

import asyncio
import importlib.util
import json
import subprocess
import sys
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest
from applier_service import main as applier
from applier_service.agent_def import load_agent
from applier_service.claude_cli import ClaudeError, parse_result
from applier_service.fill_form import fill_prompt
from applier_service.settings import load_settings
from applier_service.tailor import allowed_tools, application_dir_name, write_job_description
from leadscout_common.bus import PAYLOAD_FIELD, Bus
from leadscout_common.schemas import ApplyCommand, Event, EventType, Stream

GUARD_PATH = Path(__file__).parents[1] / "claude" / "guard_submit.py"
spec = importlib.util.spec_from_file_location("guard_submit", GUARD_PATH)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

COMMAND = ApplyCommand(
    action="tailor",
    job_id="abc12345ffff",
    url="https://jobs.example.com/1",
    title="Senior AI Engineer (Remote, EU)",
    company="Acme AI, Inc.",
    description="Build agents.",
)
CLICK = "mcp__applybrowser__browser_click"
TYPE = "mcp__applybrowser__browser_type"
UPLOAD = "mcp__applybrowser__browser_file_upload"


# --- Tailoring -------------------------------------------------------------------


def test_application_folder_is_unique_per_lead() -> None:
    name = application_dir_name(COMMAND, date(2026, 11, 11))

    assert name == "2026-11-11-acme-ai-senior-ai-engineer-remote-abc12345"


def test_job_description_file_has_title_url_and_text(tmp_path: Path) -> None:
    text = write_job_description(COMMAND, tmp_path / "app").read_text()

    assert text.startswith(
        "Senior AI Engineer (Remote, EU)\nAcme AI, Inc.\nhttps://jobs.example.com/1"
    )
    assert "Build agents." in text


def test_tailoring_may_run_only_the_skill_scripts_and_write_only_its_folder(tmp_path: Path) -> None:
    settings = replace(load_settings(), skill_dir=tmp_path / "skill")
    folder = tmp_path / "out" / "app"

    tools = allowed_tools(settings, folder)

    assert f"Write(/{folder}/**)" in tools and str(folder).startswith("/")
    assert f"Bash(python3 {tmp_path}/skill/scripts/render_cv.py:*)" in tools
    assert not any(tool in {"Bash", "Write", "Edit", "Bash(python3:*)"} for tool in tools)


# --- Form filling --------------------------------------------------------------


def test_the_agent_gets_only_the_application_section(tmp_path: Path) -> None:
    folder = tmp_path / "app"
    folder.mkdir()
    (folder / "CV_Acme.pdf").write_bytes(b"%PDF")
    (folder / "Cover_Letter_Acme.pdf").write_bytes(b"%PDF")
    profile = tmp_path / "profile.yaml"
    profile.write_text(
        "preferences:\n  minimum_salary: EUR 90,000\n"
        "application:\n  full_name: Test Applicant\n  salary_expectation: ''\n"
    )

    prompt = fill_prompt(COMMAND, folder, profile)

    assert "full_name: Test Applicant" in prompt
    assert "90,000" not in prompt and "salary_expectation" not in prompt
    assert f"Tailored CV to upload: {folder / 'CV_Acme.pdf'}" in prompt
    assert f"Cover letter PDF to upload: {folder / 'Cover_Letter_Acme.pdf'}" in prompt


def test_agent_definition_has_no_tool_list_so_the_report_tool_survives() -> None:
    agent = load_agent()

    assert set(agent) == {"description", "prompt"}
    assert "Never submit the application" in agent["prompt"]


# --- Submit guard --------------------------------------------------------------


@pytest.fixture
def guard_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "app"
    folder.mkdir()
    (folder / "cv.pdf").write_bytes(b"%PDF")
    monkeypatch.setenv("LEADSCOUT_UPLOAD_DIR", str(folder))
    monkeypatch.setenv("LEADSCOUT_GUARD_STATE", str(tmp_path / "state"))
    return folder


@pytest.mark.parametrize(
    "element",
    [
        "Submit application button",
        "Send",
        "Finish and submit",
        "Confirm",
        "Enviar candidatura button",
        "Bewerbung absenden",
        "Envoyer ma candidature",
    ],
)
def test_guard_blocks_submit_clicks(guard_env: Path, element: str) -> None:
    assert guard.denial(CLICK, {"element": element, "target": "e1"}) is not None


@pytest.mark.parametrize(
    "element", ["Apply now button", "Next", "Confirm email textbox", "Upload resume"]
)
def test_guard_allows_ordinary_clicks(guard_env: Path, element: str) -> None:
    assert guard.denial(CLICK, {"element": element, "target": "e1"}) is None


def test_guard_refuses_a_click_without_a_description(guard_env: Path) -> None:
    assert guard.denial(CLICK, {"target": "e87"}) is not None


def test_apply_is_blocked_once_filling_has_started(guard_env: Path) -> None:
    assert guard.denial(CLICK, {"element": "Apply button", "target": "e1"}) is None
    guard.note_filling_started()

    assert guard.denial(CLICK, {"element": "Apply button", "target": "e9"}) is not None


def test_guard_blocks_enter_in_every_form(guard_env: Path) -> None:
    assert guard.denial("mcp__applybrowser__browser_press_key", {"key": "Enter"}) is not None
    assert guard.denial(TYPE, {"text": "x", "submit": True}) is not None
    assert guard.denial(TYPE, {"text": "Name\n", "slowly": True}) is not None
    assert guard.denial(TYPE, {"text": "Line one\nLine two"}) is None  # fill() types no keys


def test_guard_limits_uploads_to_the_application_folder(guard_env: Path, tmp_path: Path) -> None:
    secret = tmp_path / "id_ed25519"
    secret.write_text("key")

    assert guard.denial(UPLOAD, {"paths": [str(guard_env / "cv.pdf")]}) is None
    assert guard.denial(UPLOAD, {"paths": [str(secret)]}) is not None
    assert guard.denial(UPLOAD, {"paths": [str(guard_env / ".." / "id_ed25519")]}) is not None


@pytest.mark.parametrize("url", ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)"])
def test_guard_blocks_non_web_addresses(
    guard_env: Path, url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LEADSCOUT_ALLOWED_SITE", "jobs.example.com")
    assert guard.denial("mcp__applybrowser__browser_navigate", {"url": url}) is not None


def test_guard_fails_closed_on_bad_input() -> None:
    result = subprocess.run(
        [sys.executable, str(GUARD_PATH)], input="not json", capture_output=True, text=True
    )

    assert result.returncode == 2


# --- Claude Code results -------------------------------------------------------


def test_parse_result_reads_structured_output_cost_usage_and_denials() -> None:
    envelope = {
        "result": "done",
        "structured_output": {"outcome": "filled"},
        "total_cost_usd": 0.42,
        "usage": {"input_tokens": 12, "output_tokens": 30, "cache_read_input_tokens": 900},
        "permission_denials": [{"tool_name": "Bash"}, {"tool_name": "Bash"}],
    }

    result = parse_result(json.dumps(envelope), "", 0)

    assert result.structured == {"outcome": "filled"}
    assert result.cost_usd == 0.42
    assert result.usage["input"] == 12 and result.usage["cache_read_input_tokens"] == 900
    assert result.denied_tools == ["Bash"]


def test_parse_result_raises_on_error() -> None:
    with pytest.raises(ClaudeError):
        parse_result('{"is_error": true, "result": "not logged in"}', "", 1)
    with pytest.raises(ClaudeError):
        parse_result("", "command not found", 127)


# --- Interrupted actions -------------------------------------------------------


async def emitted(bus: Bus) -> list[Event]:
    entries = await bus.redis.xrange(Stream.EVENTS.value)
    return [Event.model_validate_json(fields[PAYLOAD_FIELD]) for _, fields in entries]


async def test_stopping_the_worker_mid_action_reports_it(
    bus: Bus, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def never_finishes(command: ApplyCommand, settings: object) -> dict:
        await asyncio.sleep(3600)
        return {}

    monkeypatch.setattr(applier, "tailor", never_finishes)
    task = asyncio.create_task(applier.handle_command(bus, COMMAND, load_settings()))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert [e.type for e in await emitted(bus)] == [EventType.ITEM_STARTED, EventType.ITEM_FAILED]
    assert await bus.redis.get(applier.IN_PROGRESS_KEY) is None


async def test_an_action_cut_off_by_a_hard_kill_is_reported_at_start(bus: Bus) -> None:
    await bus.redis.set(applier.IN_PROGRESS_KEY, COMMAND.model_dump_json())

    await applier.report_interrupted(bus)

    (failed,) = await emitted(bus)
    assert failed.type == EventType.ITEM_FAILED and failed.job_id == COMMAND.job_id


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://boards.greenhouse.io/acme/jobs/1", True),
        ("https://greenhouse.io/x", True),
        ("https://www.linkedin.com/messaging/", False),
        ("https://www.linkedin.com\\@boards.greenhouse.io/", False),
        ("https://user@boards.greenhouse.io/", False),
        ("https://evilgreenhouse.io/", False),
    ],
)
def test_typed_addresses_stay_on_the_posting_site(
    guard_env: Path, monkeypatch: pytest.MonkeyPatch, url: str, allowed: bool
) -> None:
    monkeypatch.setenv("LEADSCOUT_ALLOWED_SITE", "boards.greenhouse.io")

    denied = guard.denial("mcp__applybrowser__browser_navigate", {"url": url})

    assert (denied is None) == allowed


def test_navigation_is_refused_when_no_site_is_configured(
    guard_env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("LEADSCOUT_ALLOWED_SITE", raising=False)

    assert guard.denial("mcp__applybrowser__browser_navigate", {"url": "https://a.com/"})


# --- Claude access ---------------------------------------------------------------


def test_login_access_hides_api_keys_from_the_session(monkeypatch: pytest.MonkeyPatch) -> None:
    from applier_service.claude_cli import session_env

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "token")

    env = session_env(access="login")

    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert session_env(access="console")["ANTHROPIC_API_KEY"] == "sk-ant-test"


def test_console_access_without_a_key_fails_before_starting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from applier_service.claude_cli import session_env

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with pytest.raises(ClaudeError, match="ANTHROPIC_API_KEY"):
        session_env(access="console")


def test_setup_page_choices_reach_the_session() -> None:
    from leadscout_common.schemas import Settings

    chosen = Settings(claude_access="console", tailor_budget_usd=3, fill_budget_usd=0)
    settings = applier.with_user_choices(load_settings(), chosen)

    assert (settings.claude_access, settings.tailor_budget_usd, settings.fill_budget_usd) == (
        "console",
        3,
        0,
    )


async def test_sign_in_status_keeps_no_account_details(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = tmp_path / "claude"
    fake.write_text(
        "#!/bin/sh\n"
        'echo \'{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max",'
        ' "email": "me@example.com", "orgName": "Me"}\'\n'
    )
    fake.chmod(0o755)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    status = await applier.sign_in_status(str(fake))

    assert (status.logged_in, status.auth_method, status.subscription) == (True, "claude.ai", "max")
    assert "example.com" not in status.model_dump_json()


def test_the_key_is_read_from_env_file_without_a_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from applier_service.settings import read_api_key
    from leadscout_common.schemas import Settings

    env_file = tmp_path / ".env"
    env_file.write_text("OLLAMA_BASE_URL=http://x\n# ANTHROPIC_API_KEY=sk-old\n")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert read_api_key(env_file) == ""  # a commented-out line is not a key

    env_file.write_text('ANTHROPIC_API_KEY="sk-ant-new"  # added later\n')
    settings = replace(load_settings(), env_file=env_file)

    console = applier.with_user_choices(settings, Settings(claude_access="console"))
    assert console.api_key == "sk-ant-new"
    assert "sk-ant" not in repr(console)  # never printed in a log line
    assert applier.with_user_choices(settings, Settings()).api_key == ""  # login: no key


def test_console_session_gets_the_key_read_from_env_file(monkeypatch: pytest.MonkeyPatch) -> None:
    from applier_service.claude_cli import session_env

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    assert (
        session_env(access="console", api_key="sk-ant-file")["ANTHROPIC_API_KEY"] == "sk-ant-file"
    )
    assert "ANTHROPIC_API_KEY" not in session_env(access="login", api_key="sk-ant-file")


def test_tailor_model_is_one_model_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    from applier_service import claude_cli
    from leadscout_common.schemas import Settings
    from pydantic import ValidationError

    settings = applier.with_user_choices(load_settings(), Settings(tailor_model="opus"))
    assert settings.tailor_model == "opus"
    for bad in ("--dangerously-skip-permissions", "opus --tools Bash", "Opus"):
        with pytest.raises(ValidationError):
            Settings(tailor_model=bad)
    assert Settings(tailor_model="claude-opus-5-5[1m]").tailor_model == "claude-opus-5-5[1m]"

    seen: list[list[str]] = []

    async def fake_run(command, *_args):
        seen.append(command)
        return claude_cli.ClaudeResult(text="ok", structured=None)

    monkeypatch.setattr(claude_cli, "_run", fake_run)
    run = claude_cli.run_claude
    asyncio.run(run("claude", "p", Path("."), [], 10, "t", "job", model="sonnet"))
    asyncio.run(run("claude", "p", Path("."), [], 10, "t", "job"))

    assert seen[0][-2:] == ["--model", "sonnet"]
    assert "--model" not in seen[1]


# --- What the Cost page reads ------------------------------------------------------


async def test_every_outcome_says_who_paid_and_a_failed_session_keeps_its_cost(
    bus: Bus, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fails_after_spending(command: ApplyCommand, settings: object) -> dict:
        raise ClaudeError("no PDF produced", cost_usd=1.25)

    monkeypatch.setattr(applier, "tailor", fails_after_spending)
    settings = replace(load_settings(), claude_access="console", tailor_model="opus")

    await applier.handle_command(bus, COMMAND, settings)

    failed = (await emitted(bus))[-1]
    assert failed.type == EventType.ITEM_FAILED
    assert failed.data == {
        "action": "tailor",
        "error": "no PDF produced",
        "cost_usd": 1.25,
        "access": "console",
        "model": "opus",
    }


def test_an_error_result_still_reports_what_the_session_cost() -> None:
    with pytest.raises(ClaudeError) as caught:
        parse_result(
            '{"is_error": true, "result": "budget exceeded", "total_cost_usd": 5.0}', "", 1
        )

    assert caught.value.cost_usd == 5.0
