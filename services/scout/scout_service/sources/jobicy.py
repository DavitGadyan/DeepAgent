"""Jobicy: GET jobicy.com/api/jobs (keyless; spec at jobicy.com/api/openapi.json).

Terms: at most one sync per hour, credit Jobicy as the source and link to the job URL.
"""

from __future__ import annotations

from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings
from .guard import guarded_fetch
from .text import format_salary, html_to_text, join_parts, parse_date

API_URL = "https://jobicy.com/api/jobs"
MAX_COUNT = 100  # the largest page the API returns
MIN_SECONDS_BETWEEN_SYNCS = 3600
FILTERS = ("tag", "industry", "geo")


class JobicySource:
    name: ClassVar[str] = "jobicy"
    label: ClassVar[str] = "Jobicy"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        """One request; a second run within the hour reuses the previous result."""

        async def request() -> list[JobPosting]:
            filters = {key: ctx.settings[key] for key in FILTERS if ctx.settings.get(key)}
            response = await ctx.http.get(API_URL, params={"count": MAX_COUNT, **filters})
            response.raise_for_status()
            return build_postings(ctx, response.json().get("jobs", []), _to_posting)

        return await guarded_fetch(ctx, self, MIN_SECONDS_BETWEEN_SYNCS, request)


def _to_posting(job: dict[str, Any]) -> JobPosting:
    salary = format_salary(
        job.get("salaryMin"), job.get("salaryMax"), job.get("salaryCurrency") or "USD"
    )
    return JobPosting(
        source="jobicy",
        url=job["url"],
        title=job["jobTitle"].strip(),
        company=job.get("companyName") or "",
        location=job.get("jobGeo") or "Remote",
        description=html_to_text(job.get("jobDescription") or job.get("jobExcerpt")),
        posted_at=parse_date(job.get("pubDate")),
        remote=True,
        salary=join_parts(salary, job.get("salaryPeriod"), sep=" "),
        tags=[*job.get("jobIndustry", []), *job.get("jobType", [])],
    )
