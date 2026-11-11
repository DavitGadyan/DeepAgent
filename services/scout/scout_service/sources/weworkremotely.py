"""We Work Remotely: public RSS feeds (weworkremotely.com/remote-jobs.rss and per category)."""

from __future__ import annotations

from typing import ClassVar
from xml.etree import ElementTree

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings, fetch_each, unique_by_url
from .text import html_to_text, parse_date

DEFAULT_FEEDS = [
    "https://weworkremotely.com/categories/remote-programming-jobs.rss",
    "https://weworkremotely.com/remote-jobs.rss",
]


class WeWorkRemotelySource:
    name: ClassVar[str] = "weworkremotely"
    label: ClassVar[str] = "We Work Remotely"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        async def fetch_feed(url: str) -> list[JobPosting]:
            response = await ctx.http.get(url)
            response.raise_for_status()
            items = ElementTree.fromstring(response.text).iter("item")
            return build_postings(ctx, items, _to_posting)

        feeds = ctx.settings.get("feeds") or DEFAULT_FEEDS
        return unique_by_url(await fetch_each(self.name, feeds, fetch_feed))


def _to_posting(item: ElementTree.Element) -> JobPosting:
    company, title = _split_title(item.findtext("title", ""))
    return JobPosting(
        source="weworkremotely",
        url=item.findtext("link", "").strip(),
        title=title,
        company=company,
        location=item.findtext("region", "").strip() or "Remote",
        description=html_to_text(item.findtext("description")),
        posted_at=parse_date(item.findtext("pubDate")),
        remote=True,
        tags=[tag for tag in (item.findtext("category"), item.findtext("type")) if tag],
    )


def _split_title(raw: str) -> tuple[str, str]:
    """Feed titles read "Company: Role"; a title without a colon is all role."""
    company, separator, role = raw.partition(": ")
    return (company.strip(), role.strip()) if separator else ("", raw.strip())
