"""The embedding client against both kinds of model server."""

import pytest
import respx
from filter_service.embeddings import Embedder
from leadscout_common.config import AgentConfig

CONFIG = AgentConfig(model="bge-m3", timeout_s=5)


@pytest.fixture(autouse=True)
def no_server_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "EMBED_PROVIDER", "EMBED_BASE_URL"):
        monkeypatch.delenv(name, raising=False)


@respx.mock
async def test_ollama_embeddings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.test:11434")
    route = respx.post("http://ollama.test:11434/api/embed").respond(
        json={"embeddings": [[1.0, 0.0], [0.0, 1.0]], "prompt_eval_count": 7}
    )

    vectors = await Embedder(CONFIG).embed(["AI Engineer", "Chef"])

    assert vectors == [[1.0, 0.0], [0.0, 1.0]]
    assert route.calls.last.request.read() == b'{"model":"bge-m3","input":["AI Engineer","Chef"]}'


@respx.mock
async def test_openai_compatible_embeddings_keep_the_v1_path_and_the_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EMBED_PROVIDER", "openai")
    monkeypatch.setenv("EMBED_BASE_URL", "http://vllm.test:8002/v1")
    monkeypatch.setenv("EMBED_API_KEY", "secret")
    route = respx.post("http://vllm.test:8002/v1/embeddings").respond(
        json={
            "data": [
                {"index": 1, "embedding": [0.0, 1.0]},
                {"index": 0, "embedding": [1.0, 0.0]},
            ],
            "usage": {"prompt_tokens": 7},
        }
    )

    vectors = await Embedder(CONFIG).embed(["AI Engineer", "Chef"])

    assert vectors == [[1.0, 0.0], [0.0, 1.0]]  # by index, whatever order the server used
    assert route.calls.last.request.headers["authorization"] == "Bearer secret"
