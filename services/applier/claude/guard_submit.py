#!/usr/bin/env python3
"""PreToolUse hook for the job-applier session: the hard stops.

The agent's instructions already forbid these; this is the layer that does not depend on
the agent following them. It reads one tool call as JSON on stdin and exits 2 (deny, with
the reason on stderr for the agent) when the call would:

  1. submit the application: a click on a submit/send control, an Enter key press, typing
     with `submit`, or - once the agent has started filling the form - a click on "Apply"
  2. upload a file from outside the application folder (`LEADSCOUT_UPLOAD_DIR`)
  3. open anything that is not an http(s) page (`file://`, `chrome://`, `javascript:` ...),
     or type an address on another site than the posting's (`LEADSCOUT_ALLOWED_SITE`);
     links the agent clicks may still lead to the employer's application system

If the guard itself fails it denies the call: a broken guard must not let a submit through.

Limit worth knowing: a click is judged by the description the agent gives for the element
(a click without one is refused), so a submit button described as something else is not
caught here. That is why the agent also has no keyboard and no script tools, why it opens
its own tab, and why you review the form before submitting.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Submit verbs in the languages job boards here use (English, Spanish, German, French,
# Italian, Portuguese, Dutch, Polish).
SUBMIT_WORDS = re.compile(
    r"\b(submit|send|finish|confirm|complete|enviar|env[ií]a|postular|absenden|senden|"
    r"bewerben|abschicken|envoyer|soumettre|postuler|valider|invia|candidati|inviare|"
    r"submeter|candidatar|verzenden|versturen|solliciteren|wy[sś]lij|aplikuj)\b",
    re.IGNORECASE,
)
APPLY_WORDS = re.compile(r"\bapply\b", re.IGNORECASE)
# "Confirm e-mail" as a text field is fine to click into; as a button it is not.
FIELD_WORDS = re.compile(
    r"\b(textbox|text box|text field|field|input|checkbox|radio|combobox|dropdown|listbox)\b",
    re.IGNORECASE,
)
FILLING_TOOLS = {
    "browser_type",
    "browser_fill_form",
    "browser_select_option",
    "browser_file_upload",
}
STOP = "Blocked: this would submit the application. Stop here and write your report."


def state_file() -> Path | None:
    """Marker that the agent has started filling; set by the applier per session."""
    path = os.environ.get("LEADSCOUT_GUARD_STATE")
    return Path(path) if path else None


def filling_started() -> bool:
    marker = state_file()
    return marker is not None and marker.exists()


def note_filling_started() -> None:
    marker = state_file()
    if marker is not None:
        marker.touch()


def is_submit_control(description: str) -> bool:
    if FIELD_WORDS.search(description):
        return False
    if SUBMIT_WORDS.search(description):
        return True
    # On the posting page "Apply" opens the form. Inside the form it sends it.
    return filling_started() and bool(APPLY_WORDS.search(description))


def upload_problem(paths: list[Any]) -> str | None:
    """Uploads must be regular files inside the application folder."""
    allowed = os.environ.get("LEADSCOUT_UPLOAD_DIR")
    if not allowed:
        return "Blocked: no upload folder is configured for this session."
    root = Path(allowed).resolve()
    for raw in paths:
        path = Path(str(raw)).resolve()
        if not path.is_file() or not path.is_relative_to(root):
            return f"Blocked: only files from the application folder may be uploaded, not {raw}."
    return None


def same_site(host: str, allowed: str) -> bool:
    """The posting's host, or one of them a subdomain of the other (jobs.acme.com, acme.com)."""
    host, allowed = host.lower().rstrip("."), allowed.lower().rstrip(".")
    if host.count(".") < 1 or allowed.count(".") < 1:
        return host == allowed
    return host == allowed or host.endswith("." + allowed) or allowed.endswith("." + host)


def url_problem(url: str) -> str | None:
    # Browsers and urlparse disagree about these, so they are refused outright.
    if re.search(r"[\\\s\x00-\x1f]", url):
        return "Blocked: malformed address."
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ("http", "https") or "@" in parsed.netloc:
        return "Blocked: only plain http and https pages may be opened."
    allowed = os.environ.get("LEADSCOUT_ALLOWED_SITE", "")
    if not parsed.hostname or not allowed or not same_site(parsed.hostname, allowed):
        return "Blocked: open pages only on the posting's site; follow its links by clicking."
    return None


def denial(tool_name: str, tool_input: dict[str, Any]) -> str | None:
    """The reason to block this call, or None to allow it."""
    tool = tool_name.rsplit("__", 1)[-1]
    if "url" in tool_input and (problem := url_problem(str(tool_input["url"]))):
        return problem
    if tool == "browser_click":
        description = str(tool_input.get("element") or "").strip()
        if not description:
            return "Blocked: describe the element you click (as the page names it)."
        if is_submit_control(description):
            return STOP
    if tool == "browser_press_key" and str(tool_input.get("key", "")).lower() in {
        "enter",
        "numpadenter",
        "return",
    }:
        return STOP
    if tool in {"browser_type", "browser_fill_form"} and tool_input.get("submit"):
        return "Blocked: type without `submit`, which would press Enter."
    if (
        tool == "browser_type"
        and tool_input.get("slowly")
        and re.search(r"[\r\n]", str(tool_input.get("text", "")))
    ):
        return "Blocked: typing a line break key by key presses Enter. Type without `slowly`."
    if tool == "browser_file_upload":
        return upload_problem(list(tool_input.get("paths") or []))
    return None


def main() -> int:
    try:
        call = json.load(sys.stdin)
        tool_name = str(call.get("tool_name", ""))
        reason = denial(tool_name, call.get("tool_input") or {})
        if reason is None and tool_name.rsplit("__", 1)[-1] in FILLING_TOOLS:
            note_filling_started()
    except Exception as error:  # noqa: BLE001 - fail closed
        reason = f"Blocked: the safety guard could not check this call ({error}). Stop and report."
    if reason:
        print(reason, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
