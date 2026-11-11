from datetime import datetime

import httpx
import pytest
import respx
from scout_service.runner import rank_by_keywords
from scout_service.sources.greenhouse import GreenhouseSource

BOARD = "https://boards-api.greenhouse.io/v1/boards/{}/jobs"


@respx.mock
async def test_normalises_board_postings(make_ctx, fixture_text):
    route = respx.get(BOARD.format("anthropic")).respond(
        text=fixture_text("greenhouse_anthropic.json")
    )

    postings = await GreenhouseSource().fetch(make_ctx({"companies": ["anthropic"]}))

    assert route.calls.last.request.url.params["content"] == "true"
    first, fellows = postings
    assert first.source == "greenhouse"
    assert first.url == "https://job-boards.greenhouse.io/anthropic/jobs/5456619008"
    assert first.title == "3P Revenue Accounting & Reporting"
    assert first.company == "Anthropic"
    assert first.location == "San Francisco, CA | Seattle, WA"
    assert first.description.startswith("About Anthropic")
    assert "<" not in first.description
    assert first.posted_at == datetime.fromisoformat("2026-10-19T11:17:24-04:00")
    assert first.remote is None
    assert first.tags == ["Finance"]
    assert fellows.remote is True  # "Remote-Friendly" in the location


@respx.mock
async def test_one_bad_slug_does_not_fail_the_adapter(make_ctx, fixture_text):
    respx.get(BOARD.format("anthropic")).respond(text=fixture_text("greenhouse_anthropic.json"))
    respx.get(BOARD.format("no-such-board")).respond(404, json={"status": 404})

    settings = {"companies": ["no-such-board", "anthropic"]}
    postings = await GreenhouseSource().fetch(make_ctx(settings))

    assert len(postings) == 2


@respx.mock
async def test_error_propagates_when_every_board_fails(make_ctx):
    respx.get(BOARD.format("anthropic")).respond(500)

    with pytest.raises(httpx.HTTPStatusError) as raised:
        await GreenhouseSource().fetch(make_ctx({"companies": ["anthropic"]}))

    assert raised.value.response.status_code == 500


def board(company: str, titles: list[str]) -> dict:
    """A minimal Greenhouse board reply with one job per title."""
    jobs = [
        {"absolute_url": f"https://boards.example.com/{company}/{n}", "title": title}
        for n, title in enumerate(titles)
    ]
    return {"jobs": [{**job, "company_name": company} for job in jobs]}


@respx.mock
async def test_a_large_early_board_does_not_crowd_out_a_later_one(make_ctx):
    respx.get(BOARD.format("early")).respond(json=board("Early", ["Email Engineer"] * 400))
    respx.get(BOARD.format("late")).respond(json=board("Late", ["Machine Learning Engineer"]))
    keywords = ["AI", "Machine Learning Engineer"]  # "AI" is a shipped keyword

    postings = await GreenhouseSource().fetch(make_ctx({"companies": ["early", "late"]}))

    assert len(postings) == 401  # nothing is cut before the runner's seen filter
    assert rank_by_keywords(postings, keywords)[0].title == "Machine Learning Engineer"
