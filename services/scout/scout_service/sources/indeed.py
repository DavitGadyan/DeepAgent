"""Indeed search results page (no API). Scraped: opt-in only, single page.

Indeed's terms forbid automated access and Cloudflare answers a plain HTTP client with
403, so in practice this adapter reports "blocked". The parser reads the job-card JSON the
results page embeds (`mosaic-provider-jobcards`).
"""

from __future__ import annotations

import json
import re
from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings
from .text import html_to_text, parse_date

SEARCH_URL = "https://www.indeed.com/jobs"
JOB_URL = "https://www.indeed.com/viewjob?jk={job_key}"
DEFAULT_LOCATION = "Remote"
BLOCKED_STATUSES = {401, 403, 429}
_JOB_CARDS = re.compile(r'window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*')


class IndeedSource:
    name: ClassVar[str] = "indeed"
    label: ClassVar[str] = "Indeed"
    scraped: ClassVar[bool] = True

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        """One request: the first results page for the first keyword."""
        location = ctx.settings.get("location", DEFAULT_LOCATION)
        params = {"q": ctx.keywords[0] if ctx.keywords else "", "l": location}
        response = await ctx.http.get(SEARCH_URL, params=params)
        if response.status_code in BLOCKED_STATUSES:
            raise RuntimeError(f"Indeed blocked the request (HTTP {response.status_code})")
        response.raise_for_status()
        return build_postings(ctx, result_cards(response.text), _to_posting)


def result_cards(html: str) -> list[dict[str, Any]]:
    """The job-card records the results page embeds."""
    match = _JOB_CARDS.search(html)
    if match is None:
        raise RuntimeError("Indeed results page has no job-card data (layout changed or blocked)")
    data, _ = json.JSONDecoder().raw_decode(html, match.end())
    return data["metaData"]["mosaicProviderJobCardsModel"]["results"]


def _to_posting(card: dict[str, Any]) -> JobPosting:
    return JobPosting(
        source="indeed",
        url=JOB_URL.format(job_key=card["jobkey"]),
        title=(card.get("displayTitle") or card["title"]).strip(),
        company=card.get("company") or "",
        location=card.get("formattedLocation") or "",
        description=html_to_text(card.get("snippet")),
        posted_at=parse_date(card.get("pubDate")),
        remote=card.get("remoteLocation"),
        salary=(card.get("salarySnippet") or {}).get("text") or "",
    )
