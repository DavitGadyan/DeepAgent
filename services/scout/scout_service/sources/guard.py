"""Request guard for sources whose terms cap how often they may be asked (Remotive, Jobicy).

The guard is kept in Redis so a scout restart does not reset it, and it is claimed before
the request is sent: the terms count requests, so a failed one counts as well. Between two
allowed requests the source returns the result of the last one that worked.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from leadscout_common.schemas import JobPosting
from pydantic import TypeAdapter
from redis.asyncio import Redis

from .base import FetchContext, Source, SourceGaveUp

GUARD_KEY = "leadscout:source-guard:{source}"
RESULT_KEY = "leadscout:source-result:{source}"
_POSTINGS = TypeAdapter(list[JobPosting])


async def guarded_fetch(
    ctx: FetchContext,
    source: Source,
    min_interval_s: int,
    fetch: Callable[[], Awaitable[list[JobPosting]]],
) -> list[JobPosting]:
    """Run `fetch` at most once per `min_interval_s`; in between, reuse its last result.

    Every failure becomes `SourceGaveUp`: the guard is already armed, so a retry by the
    runner would be a second request inside the interval the terms allow.
    """
    redis = _redis(ctx, source.label)
    guard, result = GUARD_KEY.format(source=source.name), RESULT_KEY.format(source=source.name)
    if not await redis.set(guard, "1", nx=True, ex=min_interval_s):
        return await _last_result(redis, source.label, guard, result)
    try:
        postings = await fetch()
    except Exception as error:
        hours = f"{min_interval_s / 3600:g}"
        message = f"{source.label}: request failed; the next is allowed in {hours} h"
        raise SourceGaveUp(message) from error
    await redis.set(result, _POSTINGS.dump_json(postings))
    return postings


def _redis(ctx: FetchContext, label: str) -> Redis:
    if ctx.redis is None:
        raise RuntimeError(f"{label} needs FetchContext.redis for its request guard")
    return ctx.redis


async def _last_result(redis: Redis, label: str, guard: str, result: str) -> list[JobPosting]:
    stored = await redis.get(result)
    if stored is not None:
        return _POSTINGS.validate_json(stored)
    minutes = max(1, round(await redis.ttl(guard) / 60))
    raise SourceGaveUp(f"{label}: no stored result; the next request is allowed in {minutes} min")
