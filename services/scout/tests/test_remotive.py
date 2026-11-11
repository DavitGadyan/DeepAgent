import json
from datetime import UTC, datetime

import pytest
import respx
from scout_service.sources.base import SourceGaveUp
from scout_service.sources.remotive import RemotiveSource

API = "https://remotive.com/api/remote-jobs"


@respx.mock
async def test_normalises_feed(make_ctx, fixture_text):
    route = respx.get(API).respond(text=fixture_text("remotive.json"))

    postings = await RemotiveSource().fetch(make_ctx())

    assert route.call_count == 1
    sales, service_desk = postings
    assert sales.source == "remotive"
    assert sales.url == "https://remotive.com/remote-jobs/sales/inside-sales-contractor-2086540"
    assert sales.title == "Inside Sales Contractor"
    assert sales.company == "Credit Wellness, LLC"
    assert sales.location == "Worldwide"
    assert sales.posted_at == datetime(2026, 11, 8, 21, 47, 58, tzinfo=UTC)
    assert sales.remote is True
    assert sales.salary == "OTE $25k - $35k"
    assert sales.tags[-2:] == ["Sales", "full_time"]
    assert service_desk.title == "Tier III Service Desk Engineer"
    assert service_desk.description.startswith("Unió Digital is an Arizona-based")
    assert "<" not in service_desk.description


@respx.mock
async def test_at_most_one_request_per_six_hours(make_ctx, fixture_text, redis):
    route = respx.get(API).respond(text=fixture_text("remotive.json"))

    first = await RemotiveSource().fetch(make_ctx())
    second = await RemotiveSource().fetch(make_ctx())

    assert route.call_count == 1  # terms: about four requests a day
    assert second == first
    assert 0 < await redis.ttl("leadscout:source-guard:remotive") <= 6 * 3600


@respx.mock
async def test_a_failed_request_also_counts(make_ctx, fixture_text):
    route = respx.get(API).respond(503)

    with pytest.raises(SourceGaveUp) as raised:
        await RemotiveSource().fetch(make_ctx())
    route.respond(text=fixture_text("remotive.json"))
    with pytest.raises(SourceGaveUp, match="next request is allowed in 360 min"):
        await RemotiveSource().fetch(make_ctx())

    assert route.call_count == 1
    assert raised.value.__cause__.response.status_code == 503


@respx.mock
async def test_one_malformed_record_costs_only_itself(make_ctx, fixture_text):
    feed = json.loads(fixture_text("remotive.json"))
    feed["jobs"][0]["title"] = None
    respx.get(API).respond(json=feed)
    ctx = make_ctx()

    postings = await RemotiveSource().fetch(ctx)

    assert [posting.title for posting in postings] == ["Tier III Service Desk Engineer"]
    assert ctx.skipped == 1
