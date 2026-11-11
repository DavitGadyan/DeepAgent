"""Shared test helpers: fixture files captured from the real endpoints, and a FetchContext."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from scout_service.sources.base import FetchContext

FIXTURES = Path(__file__).parent / "fixtures"
KEYWORDS = ["AI Engineer", "Machine Learning Engineer"]

ContextFactory = Callable[..., FetchContext]


@pytest.fixture
def fixture_text() -> Callable[[str], str]:
    """Read a file from `tests/fixtures` as text."""
    return lambda name: (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture
def redis() -> fakeredis.aioredis.FakeRedis:
    """An in-memory Redis; every context of one test shares it, like runs of one scout."""
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
async def make_ctx(redis: fakeredis.aioredis.FakeRedis) -> AsyncIterator[ContextFactory]:
    """Build a FetchContext around a real httpx client (respx intercepts its requests)."""
    async with httpx.AsyncClient(follow_redirects=True) as http:

        def build(settings: dict[str, Any] | None = None, limit: int = 50) -> FetchContext:
            return FetchContext(
                http=http, keywords=KEYWORDS, limit=limit, settings=settings or {}, redis=redis
            )

        yield build
