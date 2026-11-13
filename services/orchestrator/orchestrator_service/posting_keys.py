"""Identity keys of a job posting: the same job gives the same key wherever it was found.

A posting is known by the id its applicant tracking system gave it, when its address
carries one, else by the address itself; and always by its company and title. Two
postings are the same job when they share a key.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from urllib.parse import urlsplit

# (system, pattern whose one group is the job id) for addresses that carry the id.
_JOB_ID_PATTERNS = (
    ("greenhouse", re.compile(r"[?&]gh_jid=(\d+)")),
    ("greenhouse", re.compile(r"greenhouse\.io/[^/?#]+/jobs/(\d+)")),
    ("ashby", re.compile(r"ashbyhq\.com/[^/?#]+/([0-9a-f-]{36})")),
    ("lever", re.compile(r"lever\.co/[^/?#]+/([0-9a-f-]{36})")),
    ("workable", re.compile(r"workable\.com/(?:[^/?#]+/)?j/([0-9a-z]+)")),
    ("linkedin", re.compile(r"linkedin\.com/jobs/view/(\d+)")),
)
_NOT_A_WORD = re.compile(r"[^a-z0-9]+")


def posting_keys(urls: Iterable[str], company: str, title: str) -> set[str]:
    """Every key of a posting known by these addresses, company and title."""
    keys = {key for url in urls for key in url_keys(url)}
    if role := role_key(company, title):
        keys.add(role)
    return keys


def url_keys(url: str) -> set[str]:
    """The job ids in the address, or the address without its query when it has none."""
    address = url.strip().lower()
    if not address:
        return set()
    ids = {
        f"{system}:{found.group(1)}"
        for system, pattern in _JOB_ID_PATTERNS
        if (found := pattern.search(address))
    }
    return ids or {f"url:{_host_and_path(address)}"}


def role_key(company: str, title: str) -> str:
    """Company and title as plain words; empty when either is missing."""
    names = [_NOT_A_WORD.sub(" ", name.lower()).strip() for name in (company, title)]
    return f"role:{names[0]}|{names[1]}" if all(names) else ""


def _host_and_path(address: str) -> str:
    parts = urlsplit(address if "//" in address else f"//{address}")
    return parts.netloc.removeprefix("www.") + parts.path.rstrip("/")
