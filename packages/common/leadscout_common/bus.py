"""Thin Redis Streams client: publish a model, consume a stream as a consumer group."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TypeVar

import redis.asyncio as redis
from pydantic import BaseModel

from .config import redis_url
from .schemas import Event, Stream

log = logging.getLogger(__name__)

M = TypeVar("M", bound=BaseModel)
PAYLOAD_FIELD = "json"
EVENTS_MAXLEN = 100_000
SOCKET_TIMEOUT_S = 30
RECONNECT_DELAY_S = 2
WRITE_ATTEMPTS = 5


class Bus:
    """One connection per service. All payloads are pydantic models serialised to JSON."""

    def __init__(self, client: redis.Redis | None = None) -> None:
        # The socket timeout must exceed the blocking read below, or every idle wait raises.
        self.redis = client or redis.from_url(
            redis_url(), decode_responses=True, socket_timeout=SOCKET_TIMEOUT_S
        )

    async def publish(self, stream: Stream, message: BaseModel) -> None:
        payload = {PAYLOAD_FIELD: message.model_dump_json()}
        await self._patiently(lambda: self.redis.xadd(stream.value, payload))

    async def emit(self, event: Event) -> None:
        """Record an event. The orchestrator stores it and relays it to the UI."""
        payload = {PAYLOAD_FIELD: event.model_dump_json()}
        await self._patiently(
            lambda: self.redis.xadd(
                Stream.EVENTS.value, payload, maxlen=EVENTS_MAXLEN, approximate=True
            )
        )

    async def _patiently[T](self, write: Callable[[], Awaitable[T]]) -> T:
        """Run one Redis write, trying again when Redis cannot be reached for a moment.

        With several workers in one agent, one failed write would otherwise stop them
        all. A write that was sent twice is harmless: events carry a unique id, and job
        consumers are idempotent.
        """
        for attempt in range(1, WRITE_ATTEMPTS + 1):
            try:
                return await write()
            except (redis.ConnectionError, redis.TimeoutError) as error:
                if attempt == WRITE_ATTEMPTS:
                    raise
                log.warning("Redis unavailable (%s); trying the write again", error)
                await asyncio.sleep(RECONNECT_DELAY_S)
        raise AssertionError("unreachable")

    async def consume(
        self, stream: Stream, group: str, model: type[M], consumer: str = "c1", block_ms: int = 5000
    ) -> AsyncIterator[tuple[str, M]]:
        """Yield `(message_id, message)` forever. Call `ack` once the message is handled.

        Unacknowledged messages from a previous crash are delivered again first, so
        handlers must be idempotent.
        """
        await self._ensure_group(stream, group)
        cursor = "0"  # first drain our pending entries, then switch to new ones
        while True:
            try:
                batches = await self.redis.xreadgroup(
                    group, consumer, {stream.value: cursor}, count=1, block=block_ms
                )
            except (redis.ConnectionError, redis.TimeoutError) as error:
                log.warning("Redis unavailable (%s); retrying", error)
                await asyncio.sleep(RECONNECT_DELAY_S)
                continue
            entries = batches[0][1] if batches else []
            if not entries:
                cursor = ">"
                continue
            for message_id, fields in entries:
                if cursor != ">":
                    # Still draining what a crash left behind: move past this entry. The
                    # caller may hand it to a worker and ask for the next one before it is
                    # acknowledged, and must not get the same job twice.
                    cursor = message_id
                try:
                    yield message_id, model.model_validate_json(fields[PAYLOAD_FIELD])
                except (ValueError, KeyError):  # invalid JSON, or an entry with no payload
                    log.exception("Dropping malformed message %s on %s", message_id, stream.value)
                    await self.ack(stream, group, message_id)

    async def ack(self, stream: Stream, group: str, message_id: str) -> None:
        await self._patiently(lambda: self.redis.xack(stream.value, group, message_id))

    async def _ensure_group(self, stream: Stream, group: str) -> None:
        try:
            await self.redis.xgroup_create(stream.value, group, id="0", mkstream=True)
        except redis.ResponseError as error:
            if "BUSYGROUP" not in str(error):
                raise

    async def close(self) -> None:
        await self.redis.aclose()
