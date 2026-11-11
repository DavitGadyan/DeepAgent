"""freelancermap.com project search pages (no API; robots.txt allows generic bots).

Each page embeds its results as JSON for the `ProjectSearch` component; that is parsed,
not the markup. The RSS feed the site advertises returns 404.
"""

from __future__ import annotations

import json
from typing import Any, ClassVar
from urllib.parse import urlencode

from leadscout_common.schemas import JobPosting
from selectolax.lexbor import LexborHTMLParser

from .base import FetchContext
from .common import build_postings, fetch_each, search_queries, unique_by_url
from .text import html_to_text, join_parts, parse_date

SITE = "https://www.freelancermap.com"
DEFAULT_MAX_QUERIES = 3
FULLY_REMOTE_PERCENT = 100
_RESULTS_SCRIPT = 'script[data-component-name="ProjectSearch"]'


class FreelancermapSource:
    name: ClassVar[str] = "freelancermap"
    label: ClassVar[str] = "freelancermap"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        """One search page per keyword, plus one page per `categories:` slug in the settings."""

        async def fetch_page(path: str) -> list[JobPosting]:
            response = await ctx.http.get(SITE + path)
            response.raise_for_status()
            return build_postings(ctx, page_projects(response.text), _to_posting)

        queries = search_queries(ctx.keywords, ctx.settings, DEFAULT_MAX_QUERIES)
        paths = [f"/projects?{urlencode({'query': query})}" for query in queries]
        paths += [f"/projects/{slug}" for slug in ctx.settings.get("categories", [])]
        return unique_by_url(await fetch_each(self.name, paths, fetch_page))


def page_projects(html: str) -> list[dict[str, Any]]:
    """The project records in the page's ProjectSearch JSON."""
    script = LexborHTMLParser(html).css_first(_RESULTS_SCRIPT)
    if script is None:
        raise RuntimeError("freelancermap page no longer embeds ProjectSearch JSON")
    return json.loads(script.text())["initialState"]["result"]["projects"]


def _to_posting(project: dict[str, Any]) -> JobPosting:
    country = (project.get("country") or {}).get("nameEn")
    skills = (project.get("matching") or {}).get("textLocalized", [])
    return JobPosting(
        source="freelancermap",
        url=f"{SITE}/project/{project['slug']}",
        title=project["title"].strip(),
        company=project.get("company") or "",
        location=join_parts(project.get("city"), country),
        description=html_to_text(project.get("description")),
        posted_at=parse_date(project.get("created")),
        remote=_is_remote(project),
        tags=[*filter(None, [project.get("contractType")]), *(skill["en"] for skill in skills)],
    )


def _is_remote(project: dict[str, Any]) -> bool | None:
    percent = (project.get("projectContractType") or {}).get("remoteInPercent")
    return None if percent is None else percent == FULLY_REMOTE_PERCENT
