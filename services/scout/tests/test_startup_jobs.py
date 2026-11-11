"""startup.jobs over a real MCP session: an in-process server stands in for api.startup.jobs."""

import asyncio
import json
from collections.abc import Collection
from datetime import UTC, datetime

import pytest
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from scout_service.sources import startup_jobs
from scout_service.sources.base import SourceGaveUp
from scout_service.sources.startup_jobs import StartupJobsSource


def fake_server(reply: str, fail_on: Collection[str] = (), stall_on: Collection[str] = ()):
    """A `search_jobs` server that answers every query with the captured reply.

    Queries in `fail_on` get a tool error, as the real server sends for its rate limit;
    queries in `stall_on` are never answered in time. `server.queries` records the calls.
    """
    server = MCPServer("startup.jobs stand-in")
    server.queries = []

    @server.tool()
    async def search_jobs(q: str, limit: int) -> str:
        server.queries.append((q, limit))
        if q in fail_on:
            raise ToolError("rate limited")
        if q in stall_on:
            await asyncio.sleep(1)  # well past the read timeout the test sets
        return reply

    return server


@pytest.fixture
def reply(fixture_text) -> str:
    """The captured `search_jobs` reply text (three jobs)."""
    return fixture_text("startup_jobs_search.json")


async def test_normalises_search_results(make_ctx, reply):
    server = fake_server(reply)

    postings = await StartupJobsSource().fetch(make_ctx({"max_queries": 2, "mcp_url": server}))

    assert server.queries == [("AI Engineer", 50), ("Machine Learning Engineer", 50)]
    arlington, woburn, unframe = postings  # duplicates across queries are dropped
    assert arlington.source == "startup_jobs"
    assert arlington.url == (
        "https://startup.jobs/lead-applied-ai-engineer-str-10742268?utm_source=mcp&utm_medium=mcp"
    )
    assert arlington.title == "Lead Applied AI Engineer"
    assert arlington.company == "STR"
    assert arlington.location == "Arlington, Virginia, U.S."
    assert arlington.posted_at == datetime(2026, 11, 10, 15, 17, 14, tzinfo=UTC)
    assert arlington.remote is False
    assert arlington.salary == "$180,000 – $230,000 per year"
    assert arlington.tags == ["Engineering", "AI Engineer", "full-time", "on-site"]
    assert arlington.description == ""  # search results are summaries
    assert woburn.location == "Woburn, Massachusetts, U.S."
    assert (unframe.company, unframe.salary) == ("Unframe", "")


async def test_a_failed_later_query_keeps_the_earlier_results(make_ctx, reply):
    server = fake_server(reply, fail_on={"Machine Learning Engineer"})

    postings = await StartupJobsSource().fetch(make_ctx({"max_queries": 2, "mcp_url": server}))

    assert len(postings) == len(json.loads(reply)["jobs"])


async def test_a_failed_first_query_is_a_readable_error(make_ctx, reply):
    server = fake_server(reply, fail_on={"AI Engineer"})

    with pytest.raises(SourceGaveUp) as raised:
        await StartupJobsSource().fetch(make_ctx({"mcp_url": server}))

    assert len(server.queries) == 1  # nothing more is sent after the failure
    assert "search_jobs failed: Error executing tool search_jobs: rate limited" in str(
        raised.value.__cause__
    )


async def test_an_unanswered_request_ends_at_the_read_timeout(make_ctx, reply, monkeypatch):
    monkeypatch.setattr(startup_jobs, "READ_TIMEOUT_SECONDS", 0.2)
    server = fake_server(reply, stall_on={"AI Engineer"})

    with pytest.raises(SourceGaveUp) as raised:
        await asyncio.wait_for(StartupJobsSource().fetch(make_ctx({"mcp_url": server})), 3)

    assert str(raised.value.__cause__)  # the reason is never empty
