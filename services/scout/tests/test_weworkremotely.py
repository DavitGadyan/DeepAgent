from datetime import UTC, datetime

import respx
from scout_service.sources.weworkremotely import DEFAULT_FEEDS, WeWorkRemotelySource


@respx.mock
async def test_parses_rss_and_drops_duplicates_across_feeds(make_ctx, fixture_text):
    for feed in DEFAULT_FEEDS:
        respx.get(feed).respond(text=fixture_text("weworkremotely.rss"))

    postings = await WeWorkRemotelySource().fetch(make_ctx())

    proxify, current = postings  # two items, each present in both feeds
    assert proxify.source == "weworkremotely"
    assert proxify.url == (
        "https://weworkremotely.com/remote-jobs/"
        "proxify-ab-senior-backend-developer-node-js-nest-js-4"
    )
    assert proxify.company == "Proxify AB"  # split from "Company: Role"
    assert proxify.title == "Senior Backend Developer (Node.js / Nest.js)"
    assert proxify.location == "Anywhere in the World"
    assert proxify.description.startswith("Headquarters: Sweden")
    assert "<" not in proxify.description
    assert proxify.posted_at == datetime(2026, 10, 19, 9, 17, 52, tzinfo=UTC)
    assert proxify.remote is True
    assert proxify.tags == ["Back-End Programming"]
    assert (current.company, current.title) == ("Current", "Freelance Marketo Email Engineer")


@respx.mock
async def test_one_failing_feed_is_skipped(make_ctx, fixture_text):
    good, bad = "https://weworkremotely.com/a.rss", "https://weworkremotely.com/b.rss"
    respx.get(good).respond(text=fixture_text("weworkremotely.rss"))
    respx.get(bad).respond(503)

    postings = await WeWorkRemotelySource().fetch(make_ctx({"feeds": [bad, good]}))

    assert len(postings) == 2
