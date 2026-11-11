"""Teamtailor career sites: the public `{site}/jobs.rss` feed every Teamtailor site serves."""

from __future__ import annotations

from functools import partial
from typing import ClassVar
from xml.etree import ElementTree

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings, fetch_each
from .text import html_to_text, join_parts, parse_date

DEFAULT_SITES = ["https://jobs.ethikos.es"]
PAGE_SIZE = 100  # items per feed page; the next page is requested with `offset`
MAX_PAGES = 4
_TT = "{https://teamtailor.com/locations}"
_REMOTE_STATUS = {"fully": True, "hybrid": False, "none": False, "onsite": False}


class TeamtailorSource:
    name: ClassVar[str] = "teamtailor"
    label: ClassVar[str] = "Teamtailor sites"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        async def fetch_site(site: str) -> list[JobPosting]:
            postings: list[JobPosting] = []
            for page in range(MAX_PAGES):
                url = f"{site.rstrip('/')}/jobs.rss"
                response = await ctx.http.get(url, params={"offset": page * PAGE_SIZE})
                response.raise_for_status()
                company, items = parse_feed(response.text)
                postings.extend(build_postings(ctx, items, partial(_to_posting, company=company)))
                if len(items) < PAGE_SIZE:
                    break
            return postings

        sites = ctx.settings.get("sites") or DEFAULT_SITES
        return await fetch_each(self.name, sites, fetch_site)


def parse_feed(xml: str) -> tuple[str, list[ElementTree.Element]]:
    """The site's name (the channel title) and the feed's <item> elements."""
    channel = ElementTree.fromstring(xml).find("channel")
    if channel is None:
        raise RuntimeError("Teamtailor feed has no <channel>")
    return channel.findtext("title", "").strip(), list(channel.iter("item"))


def _to_posting(item: ElementTree.Element, company: str) -> JobPosting:
    places = [_place(node) for node in item.iter(f"{_TT}location")]
    department, role = item.findtext(f"{_TT}department"), item.findtext(f"{_TT}role")
    return JobPosting(
        source="teamtailor",
        url=item.findtext("link", "").strip(),
        title=item.findtext("title", "").strip(),
        company=company,
        location=join_parts(*places, sep=" / "),
        description=html_to_text(item.findtext("description")),
        posted_at=parse_date(item.findtext("pubDate")),
        remote=_REMOTE_STATUS.get(item.findtext("remoteStatus", "")),
        tags=[tag for tag in (department, role) if tag],
    )


def _place(location: ElementTree.Element) -> str:
    """One place such as "Valladolid, Spain".

    The office label is often empty, so the city stands in for it. The country keeps
    same-titled jobs in different countries apart, since the location is part of the job id.
    """
    name = location.findtext(f"{_TT}name") or location.findtext(f"{_TT}city")
    return join_parts(name, location.findtext(f"{_TT}country"))
