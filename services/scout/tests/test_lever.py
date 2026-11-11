import json
from datetime import UTC, datetime

import respx
from scout_service.sources.lever import LeverSource

BOARD = "https://api.lever.co/v0/postings/{}"


@respx.mock
async def test_normalises_board_postings(make_ctx, fixture_text):
    route = respx.get(BOARD.format("zilliz")).respond(text=fixture_text("lever_zilliz.json"))

    postings = await LeverSource().fetch(make_ctx({"companies": ["zilliz"]}))

    assert route.calls.last.request.url.params["mode"] == "json"
    tokyo, new_york = postings
    assert tokyo.source == "lever"
    assert tokyo.url == "https://jobs.lever.co/zilliz/8144e236-2836-4980-92cf-b6501ce0f81c"
    assert tokyo.title == "Account Executive - Japan"
    assert tokyo.company == "Zilliz"  # the API has no company name: title-cased slug
    assert tokyo.location == "Tokyo"
    assert tokyo.description.startswith("About Zilliz")
    assert "About the Role:" in tokyo.description  # the titled lists are part of the text
    assert "<" not in tokyo.description
    assert tokyo.posted_at == datetime.fromtimestamp(1761544530.986, UTC)
    assert tokyo.remote is False  # workplaceType "hybrid"
    assert tokyo.salary == ""
    assert tokyo.tags == ["New Business Sales", "Sales", "Full-Time"]
    assert new_york.remote is True  # workplaceType "remote"
    assert new_york.salary == "USD 100,000 - 180,000 per-year-salary"


@respx.mock
async def test_company_name_override_and_failing_slug(make_ctx, fixture_text):
    respx.get(BOARD.format("zilliz")).respond(text=fixture_text("lever_zilliz.json"))
    respx.get(BOARD.format("gone")).respond(404, json={"ok": False, "error": "Document not found"})

    settings = {"companies": ["gone", "zilliz"], "names": {"zilliz": "Zilliz Inc."}}
    postings = await LeverSource().fetch(make_ctx(settings))

    assert [posting.company for posting in postings] == ["Zilliz Inc.", "Zilliz Inc."]


@respx.mock
async def test_plain_text_parts_keep_their_angle_brackets(make_ctx, fixture_text):
    board = json.loads(fixture_text("lever_zilliz.json"))
    board[0]["descriptionPlain"] = "We need <5 years of experience.\nGreat pay."
    board[0]["additionalPlain"] = "Salary > 100k and growth -> senior."
    respx.get(BOARD.format("zilliz")).respond(json=board)

    postings = await LeverSource().fetch(make_ctx({"companies": ["zilliz"]}))

    description = postings[0].description
    assert description.startswith("We need <5 years of experience.\nGreat pay.")
    assert description.endswith("Salary > 100k and growth -> senior.")
    assert "About the Role:" in description  # the HTML lists are still converted
