from datetime import datetime

import pytest
import respx
from scout_service.sources.freelancermap import FreelancermapSource

SITE = "https://www.freelancermap.com"


@respx.mock
async def test_searches_per_keyword_and_reads_embedded_projects(make_ctx, fixture_text):
    search = respx.get(f"{SITE}/projects").respond(text=fixture_text("freelancermap.html"))
    category = respx.get(f"{SITE}/projects/python-programming-language").respond(
        text=fixture_text("freelancermap.html")
    )

    settings = {"max_queries": 2, "categories": ["python-programming-language"]}
    postings = await FreelancermapSource().fetch(make_ctx(settings))

    queries = sorted(call.request.url.params["query"] for call in search.calls)
    assert queries == ["AI Engineer", "Machine Learning Engineer"]
    assert category.call_count == 1
    devops, kubernetes = postings  # the same two projects on every page, returned once
    assert devops.source == "freelancermap"
    assert devops.url == f"{SITE}/project/devops-engineer-aws-3071516"
    assert devops.title == "DevOps Engineer (AWS)"
    assert devops.company == "Xpertise"
    assert devops.location == "Yorkshire, United Kingdom"
    assert devops.description.startswith("Senior DevOps Engineer (AWS)")
    assert "<" not in devops.description
    assert devops.posted_at == datetime.fromisoformat("2026-11-11T09:35:37+01:00")
    assert devops.remote is False  # remoteInPercent 0
    assert kubernetes.company == "Amoria Bond GmbH"
    assert kubernetes.remote is True  # remoteInPercent 100
    assert kubernetes.tags[0] == "CONTRACT"


@respx.mock
async def test_clear_error_when_page_structure_changes(make_ctx):
    respx.get(f"{SITE}/projects").respond(text="<html><body></body></html>")

    with pytest.raises(RuntimeError, match="ProjectSearch"):
        await FreelancermapSource().fetch(make_ctx({"max_queries": 1}))
