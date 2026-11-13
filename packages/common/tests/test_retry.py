import httpx
import pytest
from leadscout_common.retry import is_transient, is_unreachable, with_retry


def test_transient_errors_are_recognised() -> None:
    assert is_transient(httpx.ConnectTimeout("slow"))
    assert is_transient(RuntimeError("rate limit exceeded"))
    assert not is_transient(ValueError("bad JSON"))


async def test_retries_transient_then_succeeds() -> None:
    calls = 0

    async def flaky() -> str:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ConnectionError("connection reset")
        return "ok"

    assert await with_retry(flaky, base_delay_s=0) == "ok"
    assert calls == 3


async def test_permanent_error_raises_at_once() -> None:
    calls = 0

    async def broken() -> None:
        nonlocal calls
        calls += 1
        raise ValueError("bad input")

    with pytest.raises(ValueError):
        await with_retry(broken, base_delay_s=0)
    assert calls == 1


class OllamaResponseError(Exception):
    """Shaped like ollama.ResponseError: the HTTP status is an attribute."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def test_ollama_status_errors_are_classified_by_status() -> None:
    assert is_transient(OllamaResponseError("llama runner process has terminated", 500))
    assert is_transient(OllamaResponseError("server busy", 503))
    assert not is_transient(OllamaResponseError("model 'x' not found", 404))


def test_parser_errors_are_not_retried_even_when_they_mention_a_marker() -> None:
    assert not is_transient(ValueError("invalid JSON near 'connection'"))


def test_unreachable_is_only_a_failed_connection() -> None:
    assert is_unreachable(httpx.ConnectError("refused"))
    assert is_unreachable(ConnectionError("Failed to connect to Ollama"))
    assert not is_unreachable(httpx.ReadTimeout("slow"))


def test_a_wrapped_connection_error_counts_as_unreachable() -> None:
    """The OpenAI client (vLLM) wraps the httpx error; psycopg has its own class."""
    import httpx
    from leadscout_common.retry import is_unreachable

    class APIConnectionError(Exception):
        pass

    class OperationalError(Exception):
        pass

    wrapped = RuntimeError("Connection error.")
    wrapped.__cause__ = httpx.ConnectError("refused")

    assert is_unreachable(APIConnectionError("Connection error."))
    assert is_unreachable(wrapped)
    assert is_unreachable(OperationalError("connection refused"))  # Postgres is down
    assert not is_unreachable(ValueError("bad JSON"))
