from datetime import UTC, datetime

import pytest
import respx
from scout_service.sources.zoho_recruit import ZohoRecruitSource

LISTING = "https://www.talent40.com/jobs"


@respx.mock
async def test_reads_job_records_from_flight_payload(make_ctx, fixture_text):
    respx.get(LISTING).respond(text=fixture_text("zoho_recruit.html"))

    postings = await ZohoRecruitSource().fetch(make_ctx({"sites": [LISTING]}))

    remote_job, brussels_job = postings
    assert remote_job.source == "zoho_recruit"
    assert remote_job.url == "https://www.talent40.com/jobs/609729000039728098"
    assert remote_job.title == (
        "Senior ServiceNow Developer – SecOps & GRC - Full-Remote - Contractor in USD"
    )
    assert remote_job.company == "www.talent40.com"  # no `names:` entry: the hostname
    assert remote_job.location == ""
    assert remote_job.posted_at == datetime(2026, 10, 13, tzinfo=UTC)
    assert remote_job.remote is True
    assert remote_job.tags == ["System Engineer", "Contract", "BE Consultancy"]  # department
    # The description is a "$19" pointer in the record, resolved from its text row.
    assert remote_job.description.startswith(
        "For an international organization, we are urgently looking for a Full Remote Senior"
    )
    assert "Skills: ServiceNow, ServiceNow SecOps" in remote_job.description
    assert brussels_job.title == "Senior Test Engineer | Playwright & AI-Assisted Testing"
    assert brussels_job.location == "Bruxelles, Bruxelles-Capitale, Région de, Belgium"
    assert brussels_job.remote is False
    assert brussels_job.description.startswith("For an international organization in Brussels")


@respx.mock
async def test_clear_error_when_page_has_no_records(make_ctx):
    respx.get(LISTING).respond(text="<html><body>No openings</body></html>")

    with pytest.raises(RuntimeError, match="No Zoho Recruit job records"):
        await ZohoRecruitSource().fetch(make_ctx({"sites": [LISTING]}))


@respx.mock
async def test_company_comes_from_the_site_name_not_the_department(make_ctx, fixture_text):
    respx.get(LISTING).respond(text=fixture_text("zoho_recruit.html"))

    settings = {"sites": [LISTING], "names": {LISTING: "All European Careers"}}
    postings = await ZohoRecruitSource().fetch(make_ctx(settings))

    assert {posting.company for posting in postings} == {"All European Careers"}
