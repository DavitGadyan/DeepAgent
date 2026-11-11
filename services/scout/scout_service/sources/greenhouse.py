"""Greenhouse job boards: GET boards-api.greenhouse.io/v1/boards/{slug}/jobs (public, keyless)."""

from __future__ import annotations

import html
from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings, fetch_each
from .text import html_to_text, looks_remote, parse_date

API_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"


class GreenhouseSource:
    name: ClassVar[str] = "greenhouse"
    label: ClassVar[str] = "Greenhouse boards"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        async def fetch_board(slug: str) -> list[JobPosting]:
            response = await ctx.http.get(API_URL.format(slug=slug), params={"content": "true"})
            response.raise_for_status()
            jobs = response.json().get("jobs", [])
            return build_postings(ctx, jobs, lambda job: _to_posting(job, slug))

        return await fetch_each(self.name, ctx.settings.get("companies", []), fetch_board)


def _to_posting(job: dict[str, Any], slug: str) -> JobPosting:
    location = (job.get("location") or {}).get("name", "")
    return JobPosting(
        source="greenhouse",
        url=job["absolute_url"],
        title=job["title"].strip(),
        company=job.get("company_name") or slug,
        location=location,
        # `content` is escaped HTML inside the JSON string, so it is unescaped twice.
        description=html_to_text(html.unescape(job.get("content") or "")),
        posted_at=parse_date(job.get("first_published") or job.get("updated_at")),
        remote=looks_remote(location, job["title"]),
        tags=[department["name"] for department in job.get("departments", [])],
    )
