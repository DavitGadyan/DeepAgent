"""Helpers shared by adapters: build postings safely, fetch many boards fail-soft."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from leadscout_common.schemas import JobPosting

from .base import FetchContext, SourceGaveUp

log = logging.getLogger(__name__)

MAX_PARALLEL_REQUESTS = 4
_WEB_SCHEMES = ("http://", "https://")


def build_postings[T](
    ctx: FetchContext, items: Iterable[T], to_posting: Callable[[T], JobPosting | None]
) -> list[JobPosting]:
    """Convert raw records one by one, so one malformed record costs only itself.

    A record whose conversion raises, or that yields a posting without title, company or a
    web URL, is logged and counted in `ctx.skipped`. `to_posting` returns None for a record
    that is not a job at all (an HN reply); that is not counted.
    """
    postings: list[JobPosting] = []
    for item in items:
        try:
            posting = to_posting(item)
        except Exception as error:
            log.warning("Skipping a malformed record: %r", error)
            ctx.skipped += 1
            continue
        if posting is None:
            continue
        if not is_complete(posting):
            log.warning("Skipping an incomplete %s posting: %r", posting.source, posting.url)
            ctx.skipped += 1
            continue
        postings.append(posting)
    return postings


def is_complete(posting: JobPosting) -> bool:
    """A posting the pipeline can use: it names a role and a company and links to the ad."""
    has_names = bool(posting.title.strip() and posting.company.strip())
    return has_names and posting.url.startswith(_WEB_SCHEMES)


def error_text(error: BaseException) -> str:
    """The error's message, or its type name when the message is empty (a bare ReadTimeout)."""
    return str(error) or type(error).__name__


def keep_partial[T](label: str, collected: list[T], error: BaseException) -> list[T]:
    """After a search query failed: keep what earlier queries found, else give up.

    Either way the runner must not retry the whole fetch: that would resend the queries that
    already worked, which these sites count against their limits.
    """
    if not collected:
        raise SourceGaveUp(f"{label}: no search query succeeded") from error
    log.warning("%s: keeping %d results; a later query failed: %s", label, len(collected), error)
    return collected


async def fetch_each(
    source: str,
    keys: list[str],
    fetch_one: Callable[[str], Awaitable[list[JobPosting]]],
) -> list[JobPosting]:
    """Run `fetch_one` for every key (company slug, feed URL, query).

    One failing key is logged and skipped. If every key fails the first error is raised,
    so the runner still reports a dead network or a changed API.
    """
    gate = asyncio.Semaphore(MAX_PARALLEL_REQUESTS)

    async def guarded(key: str) -> list[JobPosting] | Exception:
        async with gate:
            try:
                return await fetch_one(key)
            except Exception as error:
                log.warning("%s: skipping %s: %s", source, key, error)
                return error

    results = await asyncio.gather(*(guarded(key) for key in keys))
    errors = [result for result in results if isinstance(result, Exception)]
    if keys and len(errors) == len(keys):
        raise errors[0]
    return [posting for result in results if isinstance(result, list) for posting in result]


def unique_by_url(postings: list[JobPosting]) -> list[JobPosting]:
    """Drop repeats of the same URL (a job found by two queries or in two feeds)."""
    first_seen: dict[str, JobPosting] = {}
    for posting in postings:
        first_seen.setdefault(posting.url, posting)
    return list(first_seen.values())


def company_name(settings: dict[str, Any], slug: str) -> str:
    """Display name for a board slug: `names:` in the settings, else the slug title-cased."""
    return settings.get("names", {}).get(slug) or slug.replace("-", " ").title()


def search_queries(keywords: list[str], settings: dict[str, Any], default_max: int) -> list[str]:
    """The keywords a search-style adapter will query, limited by `max_queries`."""
    return keywords[: settings.get("max_queries", default_max)]
