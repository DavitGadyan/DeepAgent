from datetime import datetime

import httpx
import respx
from scout_service.sources.teamtailor import PAGE_SIZE, TeamtailorSource

FEED = "https://jobs.ethikos.es/jobs.rss"
LOCATIONS = "https://teamtailor.com/locations"


def feed(items: list[str]) -> str:
    """A Teamtailor feed page around the given <item> bodies."""
    body = "".join(f"<item>{item}</item>" for item in items)
    return (
        f'<rss version="2.0" xmlns:tt="{LOCATIONS}"><channel><title>Ethikos</title>'
        f"{body}</channel></rss>"
    )


def item(number: int, place: str = "", remote_status: str = "none") -> str:
    """One <item>: role number `number`, with `place` as the body of its <tt:location>."""
    return (
        f"<title>Role {number}</title><link>https://jobs.ethikos.es/jobs/{number}</link>"
        f"<remoteStatus>{remote_status}</remoteStatus>"
        f"<tt:locations><tt:location>{place}</tt:location></tt:locations>"
    )


@respx.mock
async def test_parses_site_feed(make_ctx, fixture_text):
    route = respx.get(FEED).respond(text=fixture_text("teamtailor.rss"))

    postings = await TeamtailorSource().fetch(make_ctx({"sites": ["https://jobs.ethikos.es/"]}))

    assert route.call_count == 1  # a page shorter than 100 items is the last one
    assert route.calls.last.request.url.params["offset"] == "0"
    sales, analyst, internship = postings
    assert sales.source == "teamtailor"
    assert sales.url == (
        "https://jobs.ethikos.es/jobs/8676177-tecnico-a-comercial-bombas-industriales-valladolid"
    )
    assert sales.title == "Tecnico/a Comercial - Bombas Industriales (Valladolid)"
    assert sales.company == "Ethikos"  # the feed's channel title
    assert sales.location == "Valladolid, Spain"
    assert sales.description.startswith("¡Hola!")
    assert "<" not in sales.description
    assert sales.posted_at == datetime.fromisoformat("2026-11-05T18:32:55+01:00")
    assert sales.remote is False  # remoteStatus "hybrid"
    assert sales.tags == ["Sales"]
    assert analyst.tags == ["Finance"]
    assert internship.remote is True  # remoteStatus "fully"
    assert internship.location.startswith("Andalucía, Spain / Barcelona, Spain / Santander, Spain")


@respx.mock
async def test_one_failing_site_is_skipped(make_ctx, fixture_text):
    respx.get(FEED).respond(text=fixture_text("teamtailor.rss"))
    respx.get("https://careers.example.com/jobs.rss").respond(404)

    settings = {"sites": ["https://careers.example.com", "https://jobs.ethikos.es"]}
    postings = await TeamtailorSource().fetch(make_ctx(settings))

    assert len(postings) == 3


@respx.mock
async def test_location_falls_back_to_the_city_and_names_the_country(make_ctx):
    spain = "<tt:name/><tt:city>Madrid</tt:city><tt:country>Spain</tt:country>"
    france = "<tt:name/><tt:city>Paris</tt:city><tt:country>France</tt:country>"
    respx.get(FEED).respond(text=feed([item(1, spain, "onsite"), item(1, france)]))

    madrid, paris = await TeamtailorSource().fetch(make_ctx())

    assert (madrid.location, paris.location) == ("Madrid, Spain", "Paris, France")
    assert madrid.job_id != paris.job_id  # same title, different country: two jobs
    assert madrid.remote is False  # remoteStatus "onsite"


@respx.mock
async def test_reads_the_next_page_while_pages_are_full(make_ctx):
    full_page = feed([item(number) for number in range(PAGE_SIZE)])
    last_page = feed([item(number) for number in range(PAGE_SIZE, PAGE_SIZE + 3)])
    route = respx.get(FEED).mock(
        side_effect=[httpx.Response(200, text=full_page), httpx.Response(200, text=last_page)]
    )

    postings = await TeamtailorSource().fetch(make_ctx())

    offsets = [call.request.url.params["offset"] for call in route.calls]
    assert offsets == ["0", str(PAGE_SIZE)]
    assert len(postings) == PAGE_SIZE + 3
