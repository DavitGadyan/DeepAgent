"""The push guard: every way of pushing is blocked, and look-alike commands are not."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "block_push.py"
spec = importlib.util.spec_from_file_location("block_push", HOOK)
block_push = importlib.util.module_from_spec(spec)
spec.loader.exec_module(block_push)

BLOCKED = [
    "git push",
    "git push origin main",
    "git push --force-with-lease",
    "git -C /tmp/repo push",
    "git -c user.name=x push origin HEAD",
    "git --git-dir=.git push",
    "/usr/bin/git push",
    "cd repo && git push",
    "git add -A; git commit -m wip; git push",
    "sudo git push",
    "env GIT_SSH_COMMAND=ssh git push",
    "GIT_TRACE=1 git push",
    "command git push",
    'sh -c "git push origin main"',
    "bash -lc 'cd x && git push'",
    "echo done | xargs git push",
    "(git push)",
    "echo $(git push)",
    "git push 2>&1 | tail -3",
    "bash <<EOF\ngit push\nEOF",
    "cat <<'EOF' | sh\ncd repo\ngit push origin main\nEOF",
    "gh pr create --fill",
    "gh -R owner/repo pr create --title x",
    "gh repo create my-repo --public --source . --push",
    "gh repo sync",
    "gh release create v1.0.0",
]

ALLOWED = [
    "git status",
    "git stash push -m wip",
    "git stash push",
    "git log --grep push",
    'git commit -m "fix the git push hook"',
    "git config --get remote.origin.pushurl",
    "git diff -- docs/push.md",
    'grep -rn "git push" docs/',
    "cat > notes.md <<'EOF'\nRun git push when ready.\ngh pr create --fill\nEOF",
    "cat > a.txt <<EOF\ngit push\nEOF\ngit status",
    "gh pr view 12",
    "gh pr list",
    "gh repo view",
    "gh release list",
    "docker compose push",
    "npm run create-thing",
    "echo pushing is disabled",
    "ls",
    "",
]


@pytest.mark.parametrize("command", BLOCKED)
def test_publishing_commands_are_blocked(command: str) -> None:
    assert block_push.blocked(command)


@pytest.mark.parametrize("command", ALLOWED)
def test_other_commands_are_allowed(command: str) -> None:
    assert not block_push.blocked(command)


def test_a_push_after_a_data_heredoc_is_still_blocked() -> None:
    assert block_push.blocked("cat > a.txt <<EOF\nhello\nEOF\ngit push")


def run_hook(stdin: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(HOOK)], input=stdin, capture_output=True, text=True)


def test_hook_exits_2_with_a_message_on_a_push() -> None:
    result = run_hook(json.dumps({"tool_input": {"command": "git push origin main"}}))
    assert result.returncode == 2
    assert "never pushes" in result.stderr


def test_hook_exits_0_on_an_ordinary_command() -> None:
    assert run_hook(json.dumps({"tool_input": {"command": "git status"}})).returncode == 0


def test_hook_fails_closed_when_it_cannot_read_a_command_that_mentions_push() -> None:
    assert run_hook("not json but it says push").returncode == 2
    assert run_hook("not json").returncode == 0
