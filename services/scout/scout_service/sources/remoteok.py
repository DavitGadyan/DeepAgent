"""Remote OK: GET remoteok.com/api (keyless). Terms: link back and credit Remote OK."""

from __future__ import annotations

from typing import Any, ClassVar

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings, fetch_each, unique_by_url
from .text import distinct, format_salary, html_to_text, parse_date, repair_mojibake

API_URL = "https://remoteok.com/api"
MAIN_FEED = ""


class RemoteOkSource:
    name: ClassVar[str] = "remoteok"
    label: ClassVar[str] = "Remote OK"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        """Read the main feed, or one feed per tag when `tags:` is set in the settings."""

        async def fetch_feed(tag: str) -> list[JobPosting]:
            response = await ctx.http.get(API_URL, params={"tag": tag} if tag else None)
            response.raise_for_status()
            # The first array element is the legal notice, which has no job fields.
            jobs = [item for item in response.json() if "position" in item]
            return build_postings(ctx, jobs, _to_posting)

        feeds = ctx.settings.get("tags") or [MAIN_FEED]
        return unique_by_url(await fetch_each(self.name, feeds, fetch_feed))


def _to_posting(item: dict[str, Any]) -> JobPosting:
    return JobPosting(
        source="remoteok",
        url=item["url"],
        title=repair_mojibake(item["position"]).strip(),
        company=repair_mojibake(item.get("company") or ""),
        location=repair_mojibake(item.get("location") or "") or "Remote",
        description=html_to_text(repair_mojibake(item.get("description") or "")),
        posted_at=parse_date(item.get("date")),
        remote=True,
        salary=format_salary(item.get("salary_min"), item.get("salary_max")),
        tags=distinct(item.get("tags") or []),
    )
