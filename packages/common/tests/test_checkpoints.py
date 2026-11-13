"""Checkpoint plumbing that needs no database."""

import pytest
from leadscout_common import checkpoints
from psycopg import errors


class Saver:
    def __init__(self, failures: list[Exception]) -> None:
        self.failures = failures
        self.calls = 0

    async def setup(self) -> None:
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)


async def test_losing_the_race_to_create_the_tables_is_retried(monkeypatch) -> None:
    async def no_sleep(seconds: float) -> None:
        return None

    monkeypatch.setattr("asyncio.sleep", no_sleep)
    saver = Saver([errors.UniqueViolation("pg_type_typname_nsp_index"), errors.DuplicateTable()])

    await checkpoints._create_tables(saver)

    assert saver.calls == 3


async def test_another_database_error_is_not_hidden() -> None:
    saver = Saver([errors.InsufficientPrivilege("permission denied for schema public")])

    with pytest.raises(errors.InsufficientPrivilege):
        await checkpoints._create_tables(saver)

    assert saver.calls == 1


async def test_without_a_database_url_there_is_no_checkpointer(monkeypatch) -> None:
    monkeypatch.delenv("CHECKPOINT_DB_URL", raising=False)

    assert await checkpoints.open_checkpointer() is None


def test_thread_id_is_the_job_and_the_agent() -> None:
    assert checkpoints.thread_id("abc123", "extractor") == "abc123/extractor"
