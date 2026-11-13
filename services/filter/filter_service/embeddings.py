"""Embeddings from the model server, with the role vectors cached between jobs.

Ollama: `/api/embed`. OpenAI-compatible (vLLM): `/v1/embeddings`.
"""

from __future__ import annotations

from typing import Any

import httpx
from leadscout_common.config import AgentConfig, embed_server
from leadscout_common.tracing import observe


class Embedder:
    def __init__(self, config: AgentConfig) -> None:
        server = embed_server()
        self._model = config.model
        self._openai = server.provider == "openai"
        headers = {"Authorization": f"Bearer {server.api_key}"} if server.api_key else {}
        self._http = httpx.AsyncClient(
            base_url=server.base_url, timeout=config.timeout_s, headers=headers
        )
        self._role_cache: dict[str, list[float]] = {}

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed `texts` (traced in Langfuse with its token count when tracing is on)."""
        with observe("filter.embed", "embedding", self._model, texts) as call:
            # A relative path, so the `/v1` of an OpenAI-compatible base URL is kept.
            path = "embeddings" if self._openai else "api/embed"
            response = await self._http.post(path, json={"model": self._model, "input": texts})
            response.raise_for_status()
            vectors, tokens = self._read(response.json())
            call.record(output=f"{len(vectors)} vectors", usage={"input": tokens})
            return vectors

    def _read(self, reply: dict[str, Any]) -> tuple[list[list[float]], int]:
        if self._openai:
            rows = sorted(reply["data"], key=lambda row: row.get("index", 0))
            usage = reply.get("usage") or {}
            return [row["embedding"] for row in rows], usage.get("prompt_tokens", 0)
        return reply["embeddings"], reply.get("prompt_eval_count", 0)

    async def role_vectors(self, roles: list[str]) -> dict[str, list[float]]:
        """Vectors for the target roles; only roles not seen before are embedded."""
        missing = [role for role in roles if role not in self._role_cache]
        if missing:
            self._role_cache.update(zip(missing, await self.embed(missing), strict=True))
        return {role: self._role_cache[role] for role in roles}
