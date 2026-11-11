"""Remotive: GET remotive.com/api/remote-jobs (keyless).

Terms: link back and credit Remotive, at most about four requests a day, jobs are delayed 24h.
"""

from __future__ import annotations

from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings
from .guard import guarded_fetch
from .text import html_to_text, parse_date

API_URL = "https://remotive.com/api/remote-jobs"
MIN_SECONDS_BETWEEN_REQUESTS = 6 * 3600  # four a day, as the terms allow


class RemotiveSource:
    name: ClassVar[str] = "remotive"
    label: ClassVar[str] = "Remotive"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        """One request per six hours. The public feed is small and ignores `search`/`category`."""

        async def request() -> list[JobPosting]:
            response = await ctx.http.get(API_URL)
            response.raise_for_status()
            return build_postings(ctx, response.json().get("jobs", []), _to_posting)

        return await guarded_fetch(ctx, self, MIN_SECONDS_BETWEEN_REQUESTS, request)


def _to_posting(job: dict[str, Any]) -> JobPosting:
    return JobPosting(
        source="remotive",
        url=job["url"],
        title=job["title"].strip(),
        company=job.get("company_name") or "",
        location=job.get("candidate_required_location") or "Remote",
        description=html_to_text(job.get("description")),
        posted_at=parse_date(job.get("publication_date")),
        remote=True,
        salary=job.get("salary") or "",
        tags=[*(job.get("tags") or []), *filter(None, [job.get("category"), job.get("job_type")])],
    )
