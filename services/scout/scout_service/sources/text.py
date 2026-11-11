"""Small text helpers shared by source adapters."""

from __future__ import annotations

import html
import re
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

_TAG = re.compile(r"<[^>]+>")
_BLOCK_END = re.compile(r"</(p|div|li|h[1-6]|ul|ol|tr)>|<br\s*/?>", re.IGNORECASE)
_SPACES = re.compile(r"[ \t\r\f\v]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")
_WORD = re.compile(r"[a-z0-9+#]+")
MAX_DESCRIPTION_CHARS = 12_000
# Words longer than this are cut to a stem, so "engineer" also finds "Engineering".
STEM_CHARS = 6
# Salaries above this are data errors on the board (cents, or a typo), not real offers.
MAX_PLAUSIBLE_SALARY = 5_000_000


def html_to_text(markup: str | None) -> str:
    """Strip tags, keep paragraph breaks, then unescape entities once.

    Unescaping last keeps an escaped "&lt;" as a literal "<" in the text instead of turning
    it into the start of a tag that would swallow everything up to the next ">". A feed that
    escapes its HTML twice (Greenhouse) unescapes once before calling this.
    """
    if not markup:
        return ""
    text = _BLOCK_END.sub("\n", markup)
    return tidy_text(html.unescape(_TAG.sub(" ", text)))


def tidy_text(text: str | None) -> str:
    """Normalise whitespace and cut to the description limit; for fields that are plain text."""
    if not text:
        return ""
    text = _SPACES.sub(" ", text)
    text = _BLANK_LINES.sub("\n\n", text)
    return text.strip()[:MAX_DESCRIPTION_CHARS]


def parse_date(value: str | int | float | None) -> datetime | None:
    """Accept ISO 8601, RFC 822 (RSS) or a Unix timestamp in seconds or milliseconds."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, int | float):
            seconds = value / 1000 if value > 1e11 else value
            return datetime.fromtimestamp(seconds, UTC)
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            parsed = parsedate_to_datetime(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    except (ValueError, TypeError, OverflowError):
        return None


def looks_remote(*fields: str) -> bool | None:
    """True when any field says remote; None when nothing says either way."""
    joined = " ".join(fields).lower()
    return True if "remote" in joined or "anywhere" in joined else None


def join_parts(*parts: str | None, sep: str = ", ") -> str:
    """Join the non-empty parts, dropping repeats ("Lisboa, Lisboa, Portugal")."""
    unique = dict.fromkeys(part.strip() for part in parts if part and part.strip())
    return sep.join(unique)


def distinct(items: list[str]) -> list[str]:
    """The items without repeats, first occurrence kept."""
    return list(dict.fromkeys(items))


def repair_mojibake(value: str) -> str:
    """Undo UTF-8 text that a server decoded as Latin-1 ("â\x80\x94" back to "—")."""
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def format_salary(low: float | None, high: float | None, currency: str = "USD") -> str:
    """ "USD 120,000 - 150,000", or "" when the board gave no plausible numbers."""
    amounts = [amount for amount in (low, high) if amount and 0 < amount <= MAX_PLAUSIBLE_SALARY]
    if not amounts:
        return ""
    return f"{currency} " + " - ".join(f"{amount:,.0f}" for amount in amounts)


def keyword_stems(keywords: list[str]) -> set[str]:
    """Lower-case word stems of the search phrases: ["ML Engineer"] -> {"ml", "engine"}."""
    words = _WORD.findall(" ".join(keywords).lower())
    return {word[:STEM_CHARS] for word in words}


def title_has_stem(title: str, stems: set[str]) -> bool:
    """True when a title word starts with a stem; short stems ("ai") must match whole words."""
    return any(word[:STEM_CHARS] in stems for word in _WORD.findall(title.lower()))
