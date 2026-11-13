"""Retry only what can succeed on a second try (timeouts, dropped connections, 429/5xx)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx

log = logging.getLogger(__name__)

TRANSIENT_MARKERS = (
    "timeout",
    "timed out",
    "connection",
    "rate limit",
    "overloaded",
    "temporarily",
)


UNREACHABLE = (httpx.ConnectError, httpx.ConnectTimeout, ConnectionError)
# By name, so this module needs neither package: the OpenAI client wraps the httpx error
# (vLLM down), and psycopg raises OperationalError when Postgres is down (checkpoints).
UNREACHABLE_NAMES = {"APIConnectionError", "OperationalError", "PoolTimeout"}


def is_transient(error: Exception) -> bool:
    """True for failures a second attempt can fix."""
    if isinstance(error, httpx.HTTPStatusError):
        return _retryable_status(error.response.status_code)
    # The Ollama client raises its own ResponseError, which carries the HTTP status.
    status = getattr(error, "status_code", None)
    if isinstance(status, int) and status > 0:
        return _retryable_status(status)
    if isinstance(error, httpx.TransportError | TimeoutError | ConnectionError):
        return True
    if isinstance(error, ValueError):  # parser and validation errors: same input, same failure
        return False
    return any(marker in str(error).lower() for marker in TRANSIENT_MARKERS)


def is_unreachable(error: Exception) -> bool:
    """True when the server could not be reached at all, as opposed to a failed request.

    Jobs that hit this are not the jobs' fault; the worker waits for the server instead
    of failing them.
    """
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        if isinstance(current, UNREACHABLE) or type(current).__name__ in UNREACHABLE_NAMES:
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


def _retryable_status(status: int) -> bool:
    return status == 429 or status >= 500


async def with_retry[T](
    call: Callable[[], Awaitable[T]], attempts: int = 3, base_delay_s: float = 2.0
) -> T:
    """Run `call`, retrying transient failures with linear back-off. Other errors raise at once."""
    for attempt in range(1, attempts + 1):
        try:
            return await call()
        except Exception as error:
            if attempt == attempts or not is_transient(error):
                raise
            delay = base_delay_s * attempt
            log.warning(
                "Transient error (%s); retry %d/%d in %.0fs", error, attempt, attempts - 1, delay
            )
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")
