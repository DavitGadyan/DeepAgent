"""Y Combinator jobs: ycombinator.com/jobs and its role pages (no API).

Each page embeds its listing as JSON in a `data-page` attribute; that is parsed, not the
markup. Listings carry no full description and no absolute posting date.
"""

from __future__ import annotations

import json
from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting
from selectolax.lexbor import LexborHTMLParser

from .base import FetchContext
from .common import build_postings, fetch_each, unique_by_url
from .text import join_parts, looks_remote

SITE = "https://www.ycombinator.com"
DEFAULT_PAGES = ["/jobs", "/jobs/role/software-engineer", "/jobs/role/science"]
_DETAIL_LABELS = {
    "prettyRole": "Role",
    "type": "Type",
    "minExperience": "Experience",
    "visa": "Visa",
    "equityRange": "Equity",
}


class YcJobsSource:
    name: ClassVar[str] = "yc_jobs"
    label: ClassVar[str] = "Y Combinator jobs"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        async def fetch_page(path: str) -> list[JobPosting]:
            response = await ctx.http.get(SITE + path)
            response.raise_for_status()
            return build_postings(ctx, page_jobs(response.text), _to_posting)

        pages = ctx.settings.get("pages") or DEFAULT_PAGES
        return unique_by_url(await fetch_each(self.name, pages, fetch_page))


def page_jobs(html: str) -> list[dict[str, Any]]:
    """The job records in the page's `data-page` blob; raises when YC changed its shape."""
    node = LexborHTMLParser(html).css_first("[data-page]")
    if node is None:
        raise RuntimeError("YC jobs page no longer embeds a data-page JSON blob")
    props = json.loads(node.attributes["data-page"] or "{}").get("props") or {}
    if "jobPostings" not in props:
        raise RuntimeError("YC jobs page: no jobPostings in the data-page blob")
    return props["jobPostings"]


def _to_posting(job: dict[str, Any]) -> JobPosting:
    location = job.get("location") or ""
    batch = job.get("companyBatchName")
    return JobPosting(
        source="yc_jobs",
        url=SITE + job["url"],
        title=job["title"].strip(),
        company=job.get("companyName") or "",
        location=location,
        description=_description(job),
        remote=looks_remote(location, job["title"]),
        salary=job.get("salaryRange") or "",
        tags=[tag for tag in (job.get("prettyRole"), job.get("type"), batch) if tag],
    )


def _description(job: dict[str, Any]) -> str:
    """The listing has no job text, so describe it with the facts the page does give."""
    company_line = join_parts(job.get("companyName"), job.get("companyOneLiner"), sep=": ")
    details = [f"{label}: {job[key]}" for key, label in _DETAIL_LABELS.items() if job.get(key)]
    skills = job.get("skills") or []
    if skills:
        details.append("Skills: " + ", ".join(skills))
    return "\n".join([company_line, *details])
