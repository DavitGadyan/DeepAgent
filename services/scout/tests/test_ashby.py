import json
from datetime import datetime

import respx
from scout_service.sources.ashby import AshbySource

BOARD = "https://api.ashbyhq.com/posting-api/job-board/{}"


@respx.mock
async def test_normalises_board_postings(make_ctx, fixture_text):
    route = respx.get(BOARD.format("openai")).respond(text=fixture_text("ashby_openai.json"))

    settings = {"companies": ["openai"], "names": {"openai": "OpenAI"}}
    postings = await AshbySource().fetch(make_ctx(settings))

    assert route.calls.last.request.url.params["includeCompensation"] == "true"
    remote_job, hybrid_job = postings
    assert remote_job.source == "ashby"
    assert remote_job.url == "https://jobs.ashbyhq.com/openai/c414f15f-60c4-40b5-a896-d2ad6c7f4415"
    assert remote_job.title == "Senior Technical Program Manager - Security"
    assert remote_job.company == "OpenAI"
    assert remote_job.location == (
        "US - Remote / New York City / Seattle / Washington, DC / San Francisco"
    )
    assert remote_job.description.startswith("About the Team")
    assert remote_job.posted_at == datetime.fromisoformat("2026-06-25T17:30:54.205+00:00")
    assert remote_job.remote is True
    assert remote_job.salary == "$165.4K – $285K • Offers Equity • Multiple Ranges"
    assert remote_job.tags == ["Security", "FullTime"]  # department == team, listed once
    # `isRemote` is true in the feed, but workplaceType "Hybrid" is the precise field.
    assert hybrid_job.remote is False
    assert hybrid_job.location == "San Francisco"


@respx.mock
async def test_unlisted_jobs_are_skipped_and_bad_slug_tolerated(make_ctx, fixture_text):
    board = json.loads(fixture_text("ashby_openai.json"))
    board["jobs"][0]["isListed"] = False
    respx.get(BOARD.format("openai")).respond(json=board)
    respx.get(BOARD.format("gone")).respond(404, text="Not Found")

    postings = await AshbySource().fetch(make_ctx({"companies": ["gone", "openai"]}))

    assert [posting.title for posting in postings] == [
        "Technical Program Manager, Compute Infrastructure"
    ]
    assert postings[0].company == "Openai"
