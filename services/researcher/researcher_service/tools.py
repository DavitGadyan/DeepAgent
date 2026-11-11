"""The researcher's two tools: search through the local SearXNG, and read a page.

Both tools return text for every outcome, including failures: an exception inside a tool
would end the whole research run, while an error message lets the model try again.
URLs come from search results, which are untrusted, so `fetch_page` only reads public
http(s) pages, checks every redirect hop, and checks the address it actually connected to.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urljoin, urlparse

import httpx
from langchain_core.tools import tool
from selectolax.lexbor import LexborHTMLParser

MAX_RESULTS = 5
MAX_PAGE_CHARS = 4000
MAX_REDIRECTS = 5
TIMEOUT_S = 20
USER_AGENT = "LeadScout/0.1 (personal job search research)"
READABLE_TYPES = ("text/html", "text/plain", "application/xhtml+xml")


def searxng_url() -> str:
    return os.environ.get("SEARXNG_URL", "http://localhost:8080")


def page_text(markup: str) -> str:
    """Readable text of an HTML page, without scripts, styles, navigation and form controls.

    Forms and headers are kept: some sites wrap the whole page in one form, and the
    header often holds the one line that says what the company does.
    """
    tree = LexborHTMLParser(markup)
    for node in tree.css("script, style, noscript, nav, footer, svg, input, select, button"):
        node.decompose()
    body = tree.body or tree.root
    text = body.text(separator="\n", strip=True) if body else ""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines)[:MAX_PAGE_CHARS]


def is_public_address(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_global
    except ValueError:
        return False


def is_public_url(url: str) -> bool:
    """True for an http(s) URL whose host resolves only to public addresses."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        addresses = {info[4][0] for info in socket.getaddrinfo(parsed.hostname, None)}
    except (ValueError, OSError):  # malformed URL, bad IDNA name, DNS failure
        return False
    return bool(addresses) and all(is_public_address(address) for address in addresses)


def connected_to_public_address(response: httpx.Response) -> bool:
    """The address the request really went to (DNS can change between check and use)."""
    stream = response.extensions.get("network_stream")
    peer = stream.get_extra_info("server_addr") if stream is not None else None
    return peer is None or is_public_address(peer[0])


def search_failure(payload: dict) -> str:
    """Explain an empty result list: an engine outage is not evidence that nothing exists."""
    broken = payload.get("unresponsive_engines") or []
    if not broken:
        return "No results."
    names = ", ".join(
        ": ".join(map(str, item)) if isinstance(item, list | tuple) else str(item)
        for item in broken[:5]
    )
    return (
        f"Search failed: the search engines did not answer ({names}). This is not evidence "
        "that nothing exists; try once more with a different query."
    )


@tool
async def web_search(query: str) -> str:
    """Search the web. Returns up to 5 results as 'title | url | snippet' lines."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as http:
            response = await http.get(
                f"{searxng_url()}/search", params={"q": query, "format": "json"}
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        return f"Search failed: {error or type(error).__name__}. Try again later."
    results = payload.get("results", [])[:MAX_RESULTS]
    if not results:
        return search_failure(payload)
    return "\n".join(
        f"{r.get('title', '')} | {r.get('url', '')} | {r.get('content', '')[:300]}" for r in results
    )


@tool
async def fetch_page(url: str) -> str:
    """Fetch one public web page and return its readable text (first 4000 characters)."""
    try:
        response = await _get_public(url)
    except httpx.HTTPError as error:
        return f"Could not fetch the page: {error or type(error).__name__}"
    if isinstance(response, str):
        return response
    content_type = response.headers.get("content-type", "").lower()
    if content_type and not content_type.startswith(READABLE_TYPES):
        return f"Not a readable page (it is {content_type.split(';')[0]})."
    return page_text(response.text) or "The page had no readable text."


async def _get_public(url: str) -> httpx.Response | str:
    """GET `url`, following redirects one hop at a time; a refusal comes back as text."""
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(
        timeout=TIMEOUT_S, follow_redirects=False, headers=headers
    ) as http:
        for _ in range(MAX_REDIRECTS + 1):
            if not is_public_url(url):
                return "Refused: only public http(s) pages can be fetched."
            response = await http.get(url)
            if not connected_to_public_address(response):
                return "Refused: only public http(s) pages can be fetched."
            if not response.is_redirect:
                response.raise_for_status()
                return response
            url = urljoin(url, response.headers.get("location", ""))
    return "Refused: too many redirects."
