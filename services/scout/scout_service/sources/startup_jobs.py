"""startup.jobs: `search_jobs` tool of the free MCP server at api.startup.jobs/mcp (keyless).

The REST API (api.startup.jobs/v1) has the same data but needs an API key. Terms: link the
title to the job URL and credit Startup Jobs. The free tier covers the last 14 days.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, ClassVar

from leadscout_common.schemas import JobPosting
from mcp import Client
from mcp.types import TextContent

from .base import FetchContext
from .common import build_postings, keep_partial, search_queries, unique_by_url
from .text import join_parts, parse_date

if TYPE_CHECKING:
    from mcp.server.mcpserver import MCPServer
    from mcp.types import CallToolResult

MCP_URL = "https://api.startup.jobs/mcp"
RESULTS_PER_QUERY = 50  # the tool's maximum page size
DEFAULT_MAX_QUERIES = 4  # the server allows 20 HTTP requests a minute, handshake included
# Per MCP request, handshake included; the SDK's own HTTP read timeout is 300 s.
READ_TIMEOUT_SECONDS = 30


class StartupJobsSource:
    name: ClassVar[str] = "startup_jobs"
    label: ClassVar[str] = "startup.jobs"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        """One `search_jobs` call per keyword; a failed call keeps the earlier calls' jobs."""
        queries = search_queries(ctx.keywords, ctx.settings, DEFAULT_MAX_QUERIES)
        jobs: list[dict[str, Any]] = []
        try:
            await search_jobs(ctx.settings.get("mcp_url", MCP_URL), queries, jobs)
        except Exception as error:  # the MCP client reports failures as task groups
            keep_partial(self.label, jobs, _first_leaf(error))
        return unique_by_url(build_postings(ctx, jobs, _to_posting))


async def search_jobs(
    server: str | MCPServer, queries: list[str], found: list[dict[str, Any]]
) -> None:
    """Call `search_jobs` once per query over one MCP session, appending to `found`.

    The jobs go into the caller's list rather than a return value so that the ones found
    before a failed call survive the exception. `server` is the MCP URL, or an in-process
    server in tests.
    """
    async with Client(server, read_timeout_seconds=READ_TIMEOUT_SECONDS) as client:
        for query in queries:
            arguments = {"q": query, "limit": RESULTS_PER_QUERY}
            found.extend(decode_reply(await client.call_tool("search_jobs", arguments)))


def decode_reply(result: CallToolResult) -> list[dict[str, Any]]:
    """The job summaries in one `search_jobs` reply; a tool error raises with its text."""
    reply = next((part.text for part in result.content if isinstance(part, TextContent)), "")
    if result.is_error:
        raise RuntimeError(f"startup.jobs search_jobs failed: {reply[:200]}")
    return json.loads(reply).get("jobs", [])


def _first_leaf(error: BaseException) -> BaseException:
    while isinstance(error, BaseExceptionGroup):
        error = error.exceptions[0]
    return error


def _to_posting(job: dict[str, Any]) -> JobPosting:
    place = job.get("location") or {}
    roles = [role["title"] for role in job.get("roles", [])]
    return JobPosting(
        source="startup_jobs",
        url=job["url"],
        title=job["title"].strip(),
        company=(job.get("company") or {}).get("name") or "",
        location=join_parts(place.get("city"), place.get("state"), place.get("country")),
        posted_at=parse_date(job.get("published_at")),
        remote=job.get("workplace_type") == "remote",
        salary=job.get("salary") or "",
        tags=[*roles, *filter(None, [job.get("employment_type"), job.get("workplace_type")])],
    )
