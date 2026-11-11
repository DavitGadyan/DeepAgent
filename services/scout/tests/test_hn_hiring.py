import json
from datetime import UTC, datetime

import pytest
import respx
from scout_service.sources.hn_hiring import HnHiringSource, parse_comment

SEARCH = "https://hn.algolia.com/api/v1/search_by_date"
THREAD = "https://hn.algolia.com/api/v1/items/50338728"


@respx.mock
async def test_reads_latest_hiring_thread(make_ctx, fixture_text):
    threads = json.loads(fixture_text("hn_threads.json"))
    # Put "Who wants to be hired?" first: the adapter must still pick the hiring thread.
    threads["hits"][0], threads["hits"][1] = threads["hits"][1], threads["hits"][0]
    search = respx.get(SEARCH).respond(json=threads)
    respx.get(THREAD).respond(text=fixture_text("hn_thread.json"))

    postings = await HnHiringSource().fetch(make_ctx())

    assert search.calls.last.request.url.params["tags"] == "story,author_whoishiring"
    # The third comment has no "Company | Role | ..." first line and is skipped.
    simple, bridge = postings
    assert simple.source == "hn_hiring"
    assert simple.url == "https://news.ycombinator.com/item?id=50338732"
    assert simple.company == "Simple Analytics"
    assert simple.title == "DevOps Engineer"
    assert simple.location == "REMOTE (worldwide, any timezone)"
    assert simple.remote is True
    assert simple.salary == "€5,000/month (full-time)"
    assert simple.posted_at == datetime(2026, 11, 2, 16, 1, 43, tzinfo=UTC)
    assert simple.description.startswith("Simple Analytics | DevOps Engineer | REMOTE")
    assert "\nHi HN, I'm Adriaan." in simple.description  # paragraphs are kept
    assert bridge.company == "Bridge AI Consulting"
    assert bridge.title == "AI Consultant, Junior AI Consultant"
    assert bridge.location == "REMOTE (US)"
    assert bridge.salary.startswith("$60K–$100K base")


@respx.mock
async def test_clear_error_when_no_thread_is_found(make_ctx):
    respx.get(SEARCH).respond(json={"hits": []})

    with pytest.raises(RuntimeError, match="Who is hiring"):
        await HnHiringSource().fetch(make_ctx())


def comment(first_line: str) -> dict:
    return {"id": 1, "text": f"{first_line}<p>Details.", "created_at": "2026-11-02T16:01:43Z"}


def test_a_linked_site_in_brackets_leaves_no_empty_brackets():
    link = '<a href="https:&#x2F;&#x2F;baserow.io">https:&#x2F;&#x2F;baserow.io</a>'

    posting = parse_comment(comment(f"Baserow ({link}) | Product Specialist | REMOTE (Europe)"))

    assert posting.company == "Baserow"


def test_a_lower_case_phrase_after_a_comma_is_not_a_place():
    posting = parse_comment(comment("Acme | ML Engineer | London | Full-time, visa sponsorship"))

    assert posting.location == ""  # not "Full-time, visa sponsorship"


def test_an_escaped_less_than_sign_keeps_the_text_after_it():
    text = "Acme | ML Engineer | REMOTE<p>A small team (&lt;10 ppl).<p>You build <i>RAG</i>."

    posting = parse_comment({"id": 2, "text": text})

    assert "(<10 ppl)" in posting.description
    assert posting.description.endswith("You build RAG .")  # a tag becomes a space
