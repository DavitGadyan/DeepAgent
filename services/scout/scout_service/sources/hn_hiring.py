"""Hacker News "Who is hiring?": latest monthly thread through the public Algolia HN API.

Comments are free text; the "Company | Role | Location | ..." first line is parsed best-effort.
"""

from __future__ import annotations

import re
from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings
from .text import html_to_text, looks_remote, parse_date

SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date"
ITEM_URL = "https://hn.algolia.com/api/v1/items/{story_id}"
COMMENT_URL = "https://news.ycombinator.com/item?id={comment_id}"
THREAD_TITLE = "Ask HN: Who is hiring?"
UNKNOWN_ROLE = "Hiring (see post)"

_ROLE = re.compile(
    r"engineer|developer|scientist|researcher|designer|manager|architect|analyst|founding"
    r"|programmer|devops|sre\b|head of|lead\b|intern\b|consultant|roles|positions",
    re.IGNORECASE,
)
# Case-insensitive words, but ", City" must start with a capital: "Full-time, visa" is no place.
_PLACE = re.compile(r"(?i:remote|on-?site|hybrid|in-office)|,\s*[A-Z]")
_SALARY = re.compile(r"[$€£]\s?\d")
_LINK = re.compile(r"https?://\S+")
_EMPTY_BRACKETS = re.compile(r"[(\[]\s*[)\]]")  # "Baserow (https://baserow.io)" minus the link


class HnHiringSource:
    name: ClassVar[str] = "hn_hiring"
    label: ClassVar[str] = "HN Who is hiring"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        story_id = await _latest_thread_id(ctx)
        response = await ctx.http.get(ITEM_URL.format(story_id=story_id))
        response.raise_for_status()
        comments = response.json().get("children", [])
        return build_postings(ctx, comments, parse_comment)


async def _latest_thread_id(ctx: FetchContext) -> int:
    params = {"tags": "story,author_whoishiring", "hitsPerPage": 10}
    response = await ctx.http.get(SEARCH_URL, params=params)
    response.raise_for_status()
    for hit in response.json()["hits"]:  # newest first
        if hit["title"].startswith(THREAD_TITLE):
            return int(hit["objectID"])
    raise RuntimeError("No 'Who is hiring?' thread found in the HN Algolia API")


def parse_comment(comment: dict[str, Any]) -> JobPosting | None:
    """Turn one top-level comment into a posting, or None when it is not a job ad."""
    # HN separates paragraphs with a bare <p>, which `html_to_text` would not break on.
    text = html_to_text((comment.get("text") or "").replace("<p>", "<br>"))
    first_line = text.split("\n", 1)[0]
    header = _EMPTY_BRACKETS.sub("", _LINK.sub("", first_line))
    fields = [field.strip() for field in header.split("|") if field.strip()]
    if len(fields) < 2:
        return None  # deleted comment, or a reply that does not follow the format
    company, details = fields[0], fields[1:]
    return JobPosting(
        source="hn_hiring",
        url=COMMENT_URL.format(comment_id=comment["id"]),
        title=_first_match(_ROLE, details) or UNKNOWN_ROLE,
        company=company,
        location=_first_match(_PLACE, [field for field in details if not _ROLE.search(field)]),
        description=text,
        posted_at=parse_date(comment.get("created_at")),
        remote=looks_remote(first_line),
        salary=_first_match(_SALARY, details),
    )


def _first_match(pattern: re.Pattern[str], fields: list[str]) -> str:
    return next((field for field in fields if pattern.search(field)), "")
