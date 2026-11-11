from datetime import UTC, datetime

import respx
from scout_service.sources.remoteok import RemoteOkSource

API = "https://remoteok.com/api"


@respx.mock
async def test_skips_legal_notice_and_normalises_jobs(make_ctx, fixture_text):
    respx.get(API).respond(text=fixture_text("remoteok.json"))

    postings = await RemoteOkSource().fetch(make_ctx())

    buoyant, harvey = postings  # the legal notice (first array element) is not a posting
    assert buoyant.source == "remoteok"
    assert buoyant.url.endswith("kubernetes-control-plane-buoyant-1137713")
    # The feed double-encodes UTF-8; the em dash is repaired.
    assert buoyant.title == "Senior Software Engineer — Kubernetes Control Plane"
    assert buoyant.company == "Buoyant"
    assert buoyant.location == "Remote"
    assert buoyant.description.startswith("San Francisco, United States - Senior Software")
    assert buoyant.posted_at == datetime(2026, 11, 9, 22, 0, 2, tzinfo=UTC)
    assert buoyant.remote is True
    assert buoyant.salary == ""  # salary_min/max are 0
    assert buoyant.tags[:3] == ["golang", "dev", "senior"]
    assert len(buoyant.tags) == len(set(buoyant.tags))
    assert harvey.salary == "USD 380,000 - 420,000"


@respx.mock
async def test_one_feed_per_configured_tag_without_duplicates(make_ctx, fixture_text):
    route = respx.get(API).respond(text=fixture_text("remoteok.json"))

    postings = await RemoteOkSource().fetch(make_ctx({"tags": ["ai", "python"]}))

    assert sorted(call.request.url.params["tag"] for call in route.calls) == ["ai", "python"]
    assert len(postings) == 2  # the same two jobs came back for both tags
