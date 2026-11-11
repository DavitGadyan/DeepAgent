"""Shared test fixtures: an in-memory Redis so bus tests need no server."""

import fakeredis.aioredis
import pytest
from leadscout_common.bus import Bus


@pytest.fixture
def bus() -> Bus:
    return Bus(fakeredis.aioredis.FakeRedis(decode_responses=True))
