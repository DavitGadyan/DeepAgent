"""Embeddings from Ollama's `/api/embed`, with the role vectors cached between jobs."""

from __future__ import annotations

import httpx
from leadscout_common.config import AgentConfig, ollama_base_url
from leadscout_common.tracing import observe


class Embedder:
    def __init__(self, config: AgentConfig) -> None:
        self._model = config.model
        self._http = httpx.AsyncClient(base_url=ollama_base_url(), timeout=config.timeout_s)
        self._role_cache: dict[str, list[float]] = {}

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed `texts` (traced in Langfuse with its token count when tracing is on)."""
        with observe("filter.embed", "embedding", self._model, texts) as call:
            response = await self._http.post(
                "/api/embed", json={"model": self._model, "input": texts}
            )
            response.raise_for_status()
            reply = response.json()
            call.record(
                output=f"{len(reply['embeddings'])} vectors",
                usage={"input": reply.get("prompt_eval_count", 0)},
            )
            return reply["embeddings"]

    async def role_vectors(self, roles: list[str]) -> dict[str, list[float]]:
        """Vectors for the target roles; only roles not seen before are embedded."""
        missing = [role for role in roles if role not in self._role_cache]
        if missing:
            self._role_cache.update(zip(missing, await self.embed(missing), strict=True))
        return {role: self._role_cache[role] for role in roles}
