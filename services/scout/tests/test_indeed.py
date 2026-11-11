from datetime import UTC, datetime

import pytest
import respx
from scout_service.sources.indeed import IndeedSource

SEARCH = "https://www.indeed.com/jobs"


def test_is_marked_as_scraped():
    assert IndeedSource.scraped is True


@respx.mock
async def test_cloudflare_block_is_reported_clearly(make_ctx, fixture_text):
    """`indeed_blocked.html` is the real 403 "Security Check" page a plain client gets."""
    route = respx.get(SEARCH).respond(403, text=fixture_text("indeed_blocked.html"))

    with pytest.raises(RuntimeError, match=r"^Indeed blocked the request \(HTTP 403\)$"):
        await IndeedSource().fetch(make_ctx({"location": "Remote"}))

    assert dict(route.calls.last.request.url.params) == {"q": "AI Engineer", "l": "Remote"}


@respx.mock
async def test_parses_embedded_job_cards(make_ctx, fixture_text):
    """Synthetic page: a real results page cannot be captured while Indeed blocks us."""
    respx.get(SEARCH).respond(text=fixture_text("indeed_results_synthetic.html"))

    postings = await IndeedSource().fetch(make_ctx())

    remote_job, austin_job = postings
    assert remote_job.source == "indeed"
    assert remote_job.url == "https://www.indeed.com/viewjob?jk=0123456789abcdef"
    assert remote_job.title == "AI Engineer"
    assert remote_job.company == "Example Robotics"
    assert remote_job.location == "Remote"
    assert remote_job.description == "Build and ship LLM features."
    assert remote_job.posted_at == datetime(2026, 11, 10, tzinfo=UTC)
    assert remote_job.remote is True
    assert remote_job.salary == "$150,000 - $190,000 a year"
    assert (austin_job.remote, austin_job.salary) == (False, "")


@respx.mock
async def test_clear_error_when_page_has_no_job_cards(make_ctx):
    respx.get(SEARCH).respond(text="<html><body>Something else</body></html>")

    with pytest.raises(RuntimeError, match="no job-card data"):
        await IndeedSource().fetch(make_ctx())
