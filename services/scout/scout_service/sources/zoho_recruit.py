"""Zoho Recruit career sites built with Next.js (default: talent40.com/jobs); no API.

The listing page ships its Zoho `JobOpening` records inside the Next.js flight payload
(`self.__next_f.push` script chunks). The records are read from there, not from the markup.
"""

from __future__ import annotations

import json
import re
from typing import Any, ClassVar
from urllib.parse import urlsplit

from leadscout_common.schemas import JobPosting

from .base import FetchContext
from .common import build_postings, fetch_each
from .text import join_parts, parse_date, tidy_text

DEFAULT_SITES = ["https://www.talent40.com/jobs"]
RECORD_MARKER = b'"Posting_Title"'
_FLIGHT_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')


class ZohoRecruitSource:
    name: ClassVar[str] = "zoho_recruit"
    label: ClassVar[str] = "Zoho Recruit sites"
    scraped: ClassVar[bool] = False

    async def fetch(self, ctx: FetchContext) -> list[JobPosting]:
        async def fetch_site(listing_url: str) -> list[JobPosting]:
            response = await ctx.http.get(listing_url)
            response.raise_for_status()
            rows = _flight_rows(response.text)
            records = [record for record in _job_records(rows) if record.get("Publish")]
            company = _site_name(ctx.settings, listing_url)
            return build_postings(
                ctx, records, lambda record: _to_posting(record, rows, listing_url, company)
            )

        sites = ctx.settings.get("sites") or DEFAULT_SITES
        return await fetch_each(self.name, sites, fetch_site)


def _site_name(settings: dict[str, Any], listing_url: str) -> str:
    """The employer shown for a site: `names:` in the settings, else the site's hostname.

    Not the record's department: on staffing sites that is an internal team code ("AEC").
    """
    return settings.get("names", {}).get(listing_url) or urlsplit(listing_url).hostname or ""


def _flight_rows(html: str) -> dict[str, bytes]:
    """Split the flight payload into its rows, keyed by row id.

    A row is `id:json\\n`, or `id:T<hex byte length>,<text>` for a long text such as a job
    description, which a record then points to as "$id".
    """
    payload = "".join(json.loads(chunk) for chunk in _FLIGHT_CHUNK.findall(html)).encode()
    rows: dict[str, bytes] = {}
    position = 0
    while (colon := payload.find(b":", position)) != -1:
        row_id = payload[position:colon].decode()
        if payload[colon + 1 : colon + 2] == b"T":
            comma = payload.index(b",", colon)
            start = comma + 1
            end = start + int(payload[colon + 2 : comma], 16)
            position = end
        else:
            start = colon + 1
            newline = payload.find(b"\n", start)
            end = len(payload) if newline == -1 else newline
            position = end + 1
        rows[row_id] = payload[start:end]
    return rows


def _job_records(rows: dict[str, bytes]) -> list[dict[str, Any]]:
    """The JSON array of job records: the list that opens just before the first record."""
    for row in rows.values():
        marker = row.find(RECORD_MARKER)
        if marker == -1:
            continue
        text = row.decode()
        list_start = text.rfind("[{", 0, text.find(RECORD_MARKER.decode()))
        records, _ = json.JSONDecoder().raw_decode(text, list_start)
        return records
    raise RuntimeError("No Zoho Recruit job records found in the page")


def _to_posting(
    record: dict[str, Any], rows: dict[str, bytes], listing_url: str, company: str
) -> JobPosting:
    department = (record.get("Department_Name") or {}).get("name")
    return JobPosting(
        source="zoho_recruit",
        url=f"{listing_url.rstrip('/')}/{record['id']}",
        title=record["Posting_Title"].strip(),
        company=company,
        location=join_parts(record.get("City"), record.get("State"), record.get("Country")),
        description=_description(record, rows),
        posted_at=parse_date(record.get("Date_Opened")),
        remote=record.get("Remote_Job"),
        salary=record.get("Salary") or "",
        tags=[
            *(record.get("Tags") or []),
            *filter(None, [record.get("Job_Type"), department]),
        ],
    )


def _description(record: dict[str, Any], rows: dict[str, bytes]) -> str:
    body = record.get("Job_Description") or ""
    if body.startswith("$"):  # a pointer to a text row
        body = rows.get(body[1:], b"").decode()
    skills = record.get("Required_Skills")
    parts = [body or record.get("Job_Sum_up"), f"Skills: {skills}" if skills else ""]
    return tidy_text("\n\n".join(part for part in parts if part))  # Zoho sends plain text
