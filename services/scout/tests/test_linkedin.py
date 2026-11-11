from datetime import UTC, datetime

import httpx
import pytest
import respx
from scout_service.sources.base import SourceGaveUp
from scout_service.sources.linkedin import LinkedInSource

SEARCH = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
NO_DELAY = {"delay_seconds": 0}


def test_is_marked_as_scraped():
    assert LinkedInSource.scraped is True


@respx.mock
async def test_one_request_per_keyword_and_cards_parsed(make_ctx, fixture_text):
    route = respx.get(SEARCH).respond(text=fixture_text("linkedin.html"))

    settings = {**NO_DELAY, "max_queries": 2, "location": "Spain"}
    postings = await LinkedInSource().fetch(make_ctx(settings))

    sent = [dict(call.request.url.params) for call in route.calls]
    assert sent == [
        {"keywords": "AI Engineer", "location": "Spain", "start": "0"},
        {"keywords": "Machine Learning Engineer", "location": "Spain", "start": "0"},
    ]
    graduate, conversational, senior = postings  # the repeated cards are returned once
    assert graduate.source == "linkedin"
    # Tracking parameters are removed from the link.
    assert graduate.url == (
        "https://tr.linkedin.com/jobs/view/ai-engineer-%E2%80%93-new-graduate-at-teb-arf-4484862042"
    )
    assert graduate.title == "AI Engineer – New Graduate"
    assert graduate.company == "TEB Arf"
    assert graduate.location == "Umraniye, Istanbul, Türkiye"
    assert graduate.posted_at == datetime(2026, 10, 30, tzinfo=UTC)
    assert graduate.description == ""  # search cards carry no description
    assert (conversational.company, conversational.location) == ("Arros AI", "Singapore")
    assert senior.title == "Senior AI Engineer"


@respx.mock
@pytest.mark.parametrize("status", [429, 999])
async def test_block_is_reported_clearly_and_stops_the_queries(make_ctx, status):
    route = respx.get(SEARCH).respond(status)

    with pytest.raises(SourceGaveUp) as raised:
        await LinkedInSource().fetch(make_ctx(NO_DELAY))

    assert str(raised.value.__cause__) == f"LinkedIn blocked the request (HTTP {status})"
    assert route.call_count == 1  # no further keyword is sent after a block


@respx.mock
async def test_a_later_failed_query_keeps_the_earlier_results(make_ctx, fixture_text):
    route = respx.get(SEARCH).mock(
        side_effect=[
            httpx.Response(200, text=fixture_text("linkedin.html")),
            httpx.ReadTimeout("timed out"),
        ]
    )

    postings = await LinkedInSource().fetch(make_ctx({**NO_DELAY, "max_queries": 3}))

    assert len(postings) == 3
    assert route.call_count == 2  # stopped at the failure; the third keyword was not sent
