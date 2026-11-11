#!/usr/bin/env python3
"""PreToolUse hook: stop Claude Code from publishing this repository.

Claude Code sends the Bash tool call as JSON on stdin. Exit code 2 blocks the call and
shows stderr to Claude; exit code 0 lets it run.

Blocked:
  git push            in any form: `git -C dir push`, `sudo git push`, `sh -c "git push"`
  gh pr create, gh repo create, gh repo sync, gh release create

Not blocked: commands that only mention the words, such as `git stash push`,
`git log --grep push`, `git commit -m "fix the push hook"`, or a here-document that
writes a file containing them.

This is one of four layers (see README, "Claude Code setup in this repo"). The git
pre-push hook and the disabled push URL also stop pushes this parser cannot see, such
as a git alias or a script.
"""

from __future__ import annotations

import json
import re
import shlex
import sys

MESSAGE = "Blocked by .claude/hooks/block_push.py: this project never pushes code to GitHub."
# A command without any of these words cannot publish, so it is not parsed at all.
TRIGGER = re.compile(r"\b(push|create|sync)\b")
SEPARATORS = re.compile(r"\|\||&&|\$\(|[;&|\n()`{}]")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
GH_OPTIONS_WITH_VALUE = {"-R", "--repo", "--hostname"}
BLOCKED_GH = {("pr", "create"), ("repo", "create"), ("repo", "sync"), ("release", "create")}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", "."}


def basename(token: str) -> str:
    return token.rsplit("/", 1)[-1]


def tokenise(part: str) -> list[str]:
    try:
        return shlex.split(part)
    except ValueError:
        # Unbalanced quote, for example one half of `sh -c 'cd x && git push'` after the
        # split at `&&`. A rough split with the stray quotes removed still finds the words.
        return [token.strip("'\"") for token in part.split()]


def without_data_heredocs(command: str) -> str:
    """Drop here-document bodies that are data, keeping the ones a shell will execute.

    `cat > notes.md <<EOF ... EOF` writes text; its body is not a command. A body fed
    to a shell (`bash <<EOF`, `... <<EOF | sh`) is a script and stays in for analysis.
    """
    kept: list[str] = []
    lines = command.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index]
        kept.append(line)
        index += 1
        match = HEREDOC.search(line)
        if not match:
            continue
        terminator = match.group(2)
        fed_to_shell = any(basename(token) in SHELLS for token in tokenise(HEREDOC.sub(" ", line)))
        while index < len(lines) and lines[index].strip() != terminator:
            if fed_to_shell:
                kept.append(lines[index])
            index += 1
        index += 1  # the terminator line itself
    return "\n".join(kept)


def words_after(tokens: list[str], start: int, options_with_value: set[str]) -> list[str]:
    """The non-option words that follow `tokens[start]`, skipping options and their values."""
    words = []
    index = start + 1
    while index < len(tokens):
        token = tokens[index]
        if token in options_with_value:
            index += 2
        elif token.startswith("-"):
            index += 1
        else:
            words.append(token)
            index += 1
    return words


def publishes(tokens: list[str]) -> bool:
    """True when this simple command runs `git push` or a publishing `gh` command."""
    for index, token in enumerate(tokens):
        program = basename(token)
        if program == "git":
            if words_after(tokens, index, GIT_OPTIONS_WITH_VALUE)[:1] == ["push"]:
                return True
        elif program == "gh":
            if tuple(words_after(tokens, index, GH_OPTIONS_WITH_VALUE)[:2]) in BLOCKED_GH:
                return True
        elif program in SHELLS and _runs_a_push(tokens[index + 1 :]):
            return True
    return False


def _runs_a_push(arguments: list[str]) -> bool:
    """`sh -c "git push"`: the script is one quoted token; look inside it."""
    return any(blocked(nested) for nested in arguments if " " in nested)


def blocked(command: str) -> bool:
    if not TRIGGER.search(command):
        return False
    parts = SEPARATORS.split(without_data_heredocs(command))
    return any(publishes(tokenise(part)) for part in parts)


def main() -> int:
    raw = sys.stdin.read()
    try:
        command = str(json.loads(raw).get("tool_input", {}).get("command", ""))
        is_blocked = blocked(command)
    except Exception as error:  # noqa: BLE001 - a broken guard must not wave a push through
        if "push" not in raw:
            return 0
        print(f"{MESSAGE} (the command could not be analysed: {error})", file=sys.stderr)
        return 2
    if is_blocked:
        print(MESSAGE, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
