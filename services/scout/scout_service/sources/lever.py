"""Lever postings: GET api.lever.co/v0/postings/{slug}?mode=json (public, keyless)."""

from __future__ import annotations

from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings, company_name, fetch_each
from .text import format_salary, html_to_text, join_parts, looks_remote, parse_date, tidy_text

API_URL = "https://api.lever.co/v0/postings/{slug}"
TAG_FIELDS = ("team", "department", "commitment")


class LeverSource:
    name: ClassVar[str] = "lever"
    label: ClassVar[str] = "Lever boards"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        async def fetch_board(slug: str) -> list[JobPosting]:
            response = await ctx.http.get(API_URL.format(slug=slug), params={"mode": "json"})
            response.raise_for_status()
            company = company_name(ctx.settings, slug)
            return build_postings(ctx, response.json(), lambda job: _to_posting(job, company))

        return await fetch_each(self.name, ctx.settings.get("companies", []), fetch_board)


def _to_posting(job: dict[str, Any], company: str) -> JobPosting:
    categories = job.get("categories") or {}
    location = categories.get("location") or ""
    return JobPosting(
        source="lever",
        url=job["hostedUrl"],
        title=job["text"].strip(),
        company=company,
        location=location,
        description=_description(job),
        posted_at=parse_date(job.get("createdAt")),
        remote=_is_remote(job, location),
        salary=_salary(job.get("salaryRange")),
        tags=[categories[key] for key in TAG_FIELDS if categories.get(key)],
    )


def _description(job: dict[str, Any]) -> str:
    """Lever splits a posting into a plain-text intro, titled HTML lists and a plain note.

    Only the lists go through the tag stripper: in plain text a "<" is the author's.
    """
    sections = [job.get("descriptionPlain") or ""]
    for section in job.get("lists", []):
        sections.append(f"{section.get('text', '')}\n{html_to_text(section.get('content'))}")
    sections.append(job.get("additionalPlain") or "")
    return tidy_text("\n\n".join(part for part in sections if part.strip()))


def _is_remote(job: dict[str, Any], location: str) -> bool | None:
    workplace = job.get("workplaceType")
    if workplace == "remote":
        return True
    if workplace in ("onsite", "hybrid"):
        return False
    return looks_remote(location, job["text"])


def _salary(salary_range: dict[str, Any] | None) -> str:
    if not salary_range:
        return ""
    amounts = format_salary(
        salary_range.get("min"), salary_range.get("max"), salary_range.get("currency") or ""
    )
    return join_parts(amounts.strip(), salary_range.get("interval"), sep=" ")
