import pytest
import respx
from scout_service.sources.yc_jobs import YcJobsSource

SITE = "https://www.ycombinator.com"


@respx.mock
async def test_reads_embedded_job_listing(make_ctx, fixture_text):
    respx.get(f"{SITE}/jobs").respond(text=fixture_text("yc_jobs.html"))
    respx.get(f"{SITE}/jobs/role/science").respond(text=fixture_text("yc_jobs.html"))

    settings = {"pages": ["/jobs", "/jobs/role/science"]}
    postings = await YcJobsSource().fetch(make_ctx(settings))

    soraban, cogram = postings  # the same two jobs on both pages are returned once
    assert soraban.source == "yc_jobs"
    assert soraban.url == (
        f"{SITE}/companies/soraban/jobs/pJ0mF8y-tax-accountant-cpa-ea-or-3-years-of-experience"
    )
    assert soraban.title == "Tax Accountant (CPA, EA, or >3 years of experience)"
    assert soraban.company == "Soraban"
    assert soraban.location == "Phoenix, AZ, US"
    assert soraban.salary == "$80K - $160K"
    assert soraban.remote is None
    assert soraban.posted_at is None  # the page only says "12 months"
    assert soraban.tags == ["Product", "Full-time", "W21"]
    assert soraban.description.splitlines()[:3] == [
        "Soraban: AI tax workflow platform for accounting firms",
        "Role: Product",
        "Type: Full-time",
    ]
    assert cogram.location == "Berlin, BE, DE / Remote"
    assert cogram.remote is True


@respx.mock
async def test_clear_error_when_page_structure_changes(make_ctx):
    respx.get(f"{SITE}/jobs").respond(text="<html><body><h1>Jobs</h1></body></html>")

    with pytest.raises(RuntimeError, match="data-page"):
        await YcJobsSource().fetch(make_ctx({"pages": ["/jobs"]}))


@respx.mock
async def test_clear_error_when_the_embedded_data_loses_its_job_list(make_ctx):
    page = """<div data-page='{"props": {"jobs": []}}'></div>"""
    respx.get(f"{SITE}/jobs").respond(text=page)

    with pytest.raises(RuntimeError, match="no jobPostings"):
        await YcJobsSource().fetch(make_ctx({"pages": ["/jobs"]}))
