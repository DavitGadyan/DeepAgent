"""LinkedIn guest job search (HTML fragments, no API). Scraped: opt-in only, low volume.

LinkedIn's terms forbid automated access; this sends one request per keyword with a pause
in between and reads the first results page only. It stops at the first failed request and
keeps what the earlier ones found. Cards carry no description.
"""

from __future__ import annotations

import asyncio
from typing import ClassVar

from leadscout_common.schemas import JobPosting
from selectolax.lexbor import LexborHTMLParser, LexborNode

from .base import FetchContext
from .common import build_postings, keep_partial, search_queries, unique_by_url
from .text import looks_remote, parse_date

SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
DEFAULT_MAX_QUERIES = 3
DEFAULT_LOCATION = "Worldwide"
DEFAULT_DELAY_SECONDS = 3.0
BLOCKED_STATUSES = {401, 403, 429, 999}


class LinkedInSource:
    name: ClassVar[str] = "linkedin"
    label: ClassVar[str] = "LinkedIn (guest search)"
    scraped: ClassVar[bool] = True

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        queries = search_queries(ctx.keywords, ctx.settings, DEFAULT_MAX_QUERIES)
        delay = ctx.settings.get("delay_seconds", DEFAULT_DELAY_SECONDS)
        postings: list[JobPosting] = []
        for index, query in enumerate(queries):
            if index:
                await asyncio.sleep(delay)
            try:
                cards = await _search(ctx, query)
            except Exception as error:
                return unique_by_url(keep_partial(self.label, postings, error))
            postings.extend(build_postings(ctx, cards, _to_posting))
        return unique_by_url(postings)


async def _search(ctx: FetchContext, query: str) -> list[LexborNode]:
    location = ctx.settings.get("location", DEFAULT_LOCATION)
    params = {"keywords": query, "location": location, "start": 0}
    response = await ctx.http.get(SEARCH_URL, params=params)
    if response.status_code in BLOCKED_STATUSES:
        raise RuntimeError(f"LinkedIn blocked the request (HTTP {response.status_code})")
    response.raise_for_status()
    return LexborHTMLParser(response.text).css("div.base-search-card")


def _to_posting(card: LexborNode) -> JobPosting | None:
    link = card.css_first("a.base-card__full-link")
    title = _text(card, ".base-search-card__title")
    if link is None or not title:
        return None
    location = _text(card, ".job-search-card__location")
    posted = card.css_first("time")
    return JobPosting(
        source="linkedin",
        url=(link.attributes.get("href") or "").split("?", 1)[0],  # drop tracking parameters
        title=title,
        company=_text(card, ".base-search-card__subtitle"),
        location=location,
        posted_at=parse_date(posted.attributes.get("datetime") if posted else None),
        remote=looks_remote(location, title),
    )


def _text(card: LexborNode, selector: str) -> str:
    node = card.css_first(selector)
    return node.text(strip=True) if node else ""
