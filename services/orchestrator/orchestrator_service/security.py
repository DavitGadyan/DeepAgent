"""Refuse state-changing requests that come from another web site.

The API has no login and listens on localhost. CORS alone does not stop a hostile page
open in the user's browser: a plain HTML form can POST to http://localhost:8000 without
a preflight, and POST /api/leads/{id}/tailor starts a Claude Code session. Browsers send
`Origin` (and `Sec-Fetch-Site`) on such requests, so writes are accepted only from the
UI's own origin or from clients that send neither header (curl, scripts, tests).

Written as plain ASGI middleware so it never buffers the Server-Sent Events stream.
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class SameOriginWritesMiddleware:
    def __init__(self, app: ASGIApp, allowed_origins: list[str]) -> None:
        self.app = app
        self.allowed_origins = {origin.rstrip("/") for origin in allowed_origins}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        is_write = scope["type"] == "http" and scope["method"] not in SAFE_METHODS
        if is_write and self.is_cross_site(Headers(scope=scope)):
            response = JSONResponse({"detail": "Cross-site request refused"}, status_code=403)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)

    def is_cross_site(self, headers: Headers) -> bool:
        origin = headers.get("origin")
        if origin is not None:
            return origin.rstrip("/") not in self.allowed_origins
        return headers.get("sec-fetch-site") == "cross-site"
