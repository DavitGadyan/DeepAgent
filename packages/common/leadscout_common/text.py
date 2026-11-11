"""Text matching shared by the scout (ranking) and the filter (rules)."""

from __future__ import annotations

import re


def contains_phrase(text: str, phrase: str) -> bool:
    """Case-insensitive whole-word match, so 'AI' does not match 'email' or 'maintain'."""
    pattern = rf"(?<![a-z0-9]){re.escape(phrase.lower())}(?![a-z0-9])"
    return re.search(pattern, text.lower()) is not None
