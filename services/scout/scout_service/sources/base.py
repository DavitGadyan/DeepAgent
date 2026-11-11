"""The contract every job source implements. One adapter per file in this package."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Protocol

import httpx
from leadscout_common.schemas import JobPosting
from redis.asyncio import Redis

USER_AGENT = "LeadScout/0.1 (personal job search; contact via repository owner)"


@dataclass
class FetchContext:
    """What an adapter gets for one run."""

    http: httpx.AsyncClient
    keywords: list[str]
    limit: int
    # This adapter's section of `config/sources.yaml` (company slugs, site URLs, queries…).
    settings: dict[str, Any] = field(default_factory=dict)
    # State that must outlive the process: the request guards of Remotive and Jobicy.
    redis: Redis | None = None
    # Raw records the adapter dropped as malformed; the runner reports it in source.finished.
    skipped: int = 0


class SourceGaveUp(RuntimeError):
    """A failure the runner reports at once instead of retrying the whole fetch.

    Raised when a retry would only repeat requests the site refused or already counts
    against its limits. `leadscout_common.retry.is_transient` judges an error by its message,
    so the message is fixed text without its marker words; the real error is chained as
    `__cause__` and the runner appends it to the reported reason.
    """


class Source(Protocol):
    """A place jobs come from.

    `fetch` returns normalised postings and does no relevance judgement: that is the
    filter agent's job. It may use `ctx.keywords` when the site has a search parameter.
    Network errors should propagate; the runner retries transient ones and reports the
    rest as `source.failed`. Raise `SourceGaveUp` for a failure that must not be retried.
    """

    name: ClassVar[str]
    label: ClassVar[str]
    # True for sites with no API whose terms discourage automated access.
    # These only run when ENABLE_SCRAPED_SOURCES=true.
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]: ...


def new_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT},
        timeout=httpx.Timeout(30.0),
        follow_redirects=True,
    )
