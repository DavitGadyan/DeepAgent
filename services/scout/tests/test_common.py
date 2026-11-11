import httpx
import pytest
from leadscout_common.retry import is_transient
from leadscout_common.schemas import JobPosting
from scout_service.sources.base import SourceGaveUp
from scout_service.sources.common import (
    build_postings,
    error_text,
    keep_partial,
    unique_by_url,
)
from scout_service.sources.text import (
    format_salary,
    html_to_text,
    join_parts,
    keyword_stems,
    repair_mojibake,
    tidy_text,
    title_has_stem,
)


def posting(title: str, url: str = "", company: str = "X") -> JobPosting:
    return JobPosting(
        source="test", url=url or f"https://example.com/{title}", title=title, company=company
    )


def test_short_stems_match_whole_words_only():
    stems = keyword_stems(["AI Engineer"])
    assert stems == {"ai", "engine"}
    assert title_has_stem("Head of AI", stems)
    assert not title_has_stem("Maintainer", stems)  # "ai" inside a word is not a match


def test_unique_by_url_keeps_first_occurrence():
    first, repeat = posting("A", "https://example.com/1"), posting("B", "https://example.com/1")
    assert unique_by_url([first, repeat]) == [first]


def test_text_helpers():
    assert join_parts("Lisboa", " Lisboa ", None, "Portugal") == "Lisboa, Portugal"
    assert repair_mojibake("Engineer â\x80\x94 Kubernetes") == "Engineer — Kubernetes"
    assert repair_mojibake("Zürich — ok") == "Zürich — ok"
    assert format_salary(120000, 150000) == "USD 120,000 - 150,000"
    assert format_salary(0, 0) == ""
    assert format_salary(114000000, 140000000) == ""  # implausible board data is dropped


def test_html_to_text_keeps_an_escaped_less_than_sign():
    markup = "<p>Significance p &lt; 0.05 is required</p><p>Benefits: lots &gt; none</p>"

    assert html_to_text(markup) == "Significance p < 0.05 is required\n Benefits: lots > none"


def test_tidy_text_leaves_angle_brackets_in_plain_text_alone():
    plain = "We need <5 years of experience.\n\n\n\nSalary > 100k   and growth."

    assert tidy_text(plain) == "We need <5 years of experience.\n\nSalary > 100k and growth."


def test_build_postings_skips_and_counts_bad_records(make_ctx):
    ctx = make_ctx()
    records = [
        {"title": "AI Engineer", "url": "https://example.com/1", "company": "Acme"},
        {"title": None, "url": "https://example.com/2", "company": "Acme"},  # raises
        {"title": "ML Engineer", "url": "https://example.com/3", "company": ""},
        {"title": "ML Engineer", "url": "/jobs/4", "company": "Acme"},  # no web URL
        {"title": "not a job"},  # the adapter returns None: ignored, not counted
    ]

    def to_posting(record: dict) -> JobPosting | None:
        if record["title"] == "not a job":
            return None
        return posting(record["title"].strip(), record["url"], record["company"])

    postings = build_postings(ctx, records, to_posting)

    assert [p.url for p in postings] == ["https://example.com/1"]
    assert ctx.skipped == 3


def test_keep_partial_returns_what_earlier_queries_found():
    assert keep_partial("LinkedIn", ["page 1"], httpx.ReadTimeout("")) == ["page 1"]


def test_keep_partial_gives_up_without_a_retry_when_nothing_was_found():
    with pytest.raises(SourceGaveUp) as raised:
        keep_partial("LinkedIn", [], httpx.ReadTimeout("timed out"))

    assert not is_transient(raised.value)  # the runner must not resend every query
    assert error_text(raised.value.__cause__) == "timed out"


def test_error_text_is_never_empty():
    assert error_text(httpx.ReadTimeout("")) == "ReadTimeout"
