"""Ashby job boards: GET api.ashbyhq.com/posting-api/job-board/{slug} (public, keyless)."""

from __future__ import annotations

from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings, company_name, fetch_each
from .text import distinct, html_to_text, join_parts, parse_date, tidy_text

API_URL = "https://api.ashbyhq.com/posting-api/job-board/{slug}"
TAG_FIELDS = ("department", "team", "employmentType")


class AshbySource:
    name: ClassVar[str] = "ashby"
    label: ClassVar[str] = "Ashby boards"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        async def fetch_board(slug: str) -> list[JobPosting]:
            url = API_URL.format(slug=slug)
            response = await ctx.http.get(url, params={"includeCompensation": "true"})
            response.raise_for_status()
            company = company_name(ctx.settings, slug)
            jobs = [job for job in response.json().get("jobs", []) if job.get("isListed", True)]
            return build_postings(ctx, jobs, lambda job: _to_posting(job, company))

        return await fetch_each(self.name, ctx.settings.get("companies", []), fetch_board)


def _to_posting(job: dict[str, Any], company: str) -> JobPosting:
    secondary = [place.get("location") for place in job.get("secondaryLocations", [])]
    compensation = job.get("compensation") or {}
    return JobPosting(
        source="ashby",
        url=job["jobUrl"],
        title=job["title"].strip(),
        company=company,
        location=join_parts(job.get("location"), *secondary, sep=" / "),
        description=_description(job),
        posted_at=parse_date(job.get("publishedAt")),
        remote=_is_remote(job),
        salary=compensation.get("compensationTierSummary") or "",
        tags=distinct([job[key] for key in TAG_FIELDS if job.get(key)]),
    )


def _description(job: dict[str, Any]) -> str:
    """Prefer the plain-text body; only the HTML fallback goes through the tag stripper."""
    if job.get("descriptionPlain"):
        return tidy_text(job["descriptionPlain"])
    return html_to_text(job.get("descriptionHtml"))


def _is_remote(job: dict[str, Any]) -> bool | None:
    """`workplaceType` is the precise field; `isRemote` is also true for some hybrid jobs."""
    workplace = job.get("workplaceType")
    if workplace == "Remote":
        return True
    if workplace in ("OnSite", "Hybrid"):
        return False
    return job.get("isRemote")
