from datetime import UTC, datetime

import pytest
import respx
from leadscout_common.retry import is_transient, with_retry
from scout_service.sources.base import SourceGaveUp
from scout_service.sources.jobicy import JobicySource

API = "https://jobicy.com/api/jobs"


@respx.mock
async def test_normalises_jobs_and_passes_filters(make_ctx, fixture_text):
    route = respx.get(API).respond(text=fixture_text("jobicy.json"))

    postings = await JobicySource().fetch(make_ctx({"industry": "data-science", "tag": ""}))

    params = route.calls.last.request.url.params
    assert params["count"] == "100"
    assert params["industry"] == "data-science"
    assert "tag" not in params  # empty filters are not sent
    fraud, security = postings
    assert fraud.source == "jobicy"
    assert fraud.url == "https://jobicy.com/jobs/161252-fraud-analytics-manager"
    assert fraud.title == "Fraud Analytics Manager"
    assert fraud.company == "Imprint"
    assert fraud.location == "USA"
    assert fraud.description.startswith("Who We Are")
    assert "<" not in fraud.description
    assert fraud.posted_at == datetime(2026, 11, 11, 10, 52, 36, tzinfo=UTC)
    assert fraud.remote is True
    assert fraud.salary == "USD 120,000 - 150,000 yearly"
    assert fraud.tags == ["Data Science & Analytics", "Full-Time"]
    assert security.company == "ŌURA"


@respx.mock
async def test_second_fetch_within_the_hour_reuses_the_first_sync(make_ctx, fixture_text):
    route = respx.get(API).respond(text=fixture_text("jobicy.json"))
    source = JobicySource()

    first = await source.fetch(make_ctx())
    second = await source.fetch(make_ctx())

    assert route.call_count == 1  # Jobicy's terms: no more than one sync per hour
    assert second == first


@respx.mock
async def test_the_guard_survives_a_scout_restart(make_ctx, fixture_text):
    route = respx.get(API).respond(text=fixture_text("jobicy.json"))

    await JobicySource().fetch(make_ctx())
    after_restart = await JobicySource().fetch(make_ctx())  # a new process, the same Redis

    assert route.call_count == 1
    assert len(after_restart) == 2


@respx.mock
async def test_http_429_is_not_retried_and_arms_the_guard(make_ctx):
    route = respx.get(API).respond(429)
    source = JobicySource()

    with pytest.raises(SourceGaveUp) as raised:
        await with_retry(lambda: source.fetch(make_ctx()), base_delay_s=0)

    assert not is_transient(raised.value)
    assert route.call_count == 1  # the runner's retry wrapper sent no second request
    with pytest.raises(SourceGaveUp, match="no stored result"):
        await source.fetch(make_ctx())  # still inside the hour: no request at all
    assert route.call_count == 1
