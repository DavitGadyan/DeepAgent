"""One place that builds chat models, so every agent talks to Ollama the same way."""

from __future__ import annotations

from pathlib import Path

import httpx
from langchain_core.language_models import BaseChatModel
from langchain_ollama import ChatOllama
from pydantic import BaseModel

from .config import AgentConfig, ollama_base_url
from .tracing import langchain_config

CONNECT_TIMEOUT_S = 10


def chat_model(config: AgentConfig) -> BaseChatModel:
    """A ChatOllama with an explicit context window.

    Ollama defaults to a 4k context on GPUs under 24 GB and silently truncates longer
    prompts, so `num_ctx` is always set. `profile` tells LangChain/deepagents the same
    limit; without it their summarisation assumes a 170k-token window.
    """
    return ChatOllama(
        model=config.model,
        base_url=ollama_base_url(),
        num_ctx=config.num_ctx,
        temperature=config.temperature,
        reasoning=False,  # thinking tokens cost time and are not needed for extraction
        # A short connect timeout: an unreachable host is reported in seconds, not minutes.
        client_kwargs={"timeout": httpx.Timeout(config.timeout_s, connect=CONNECT_TIMEOUT_S)},
        profile={"max_input_tokens": config.num_ctx},
    )


async def structured_call[S: BaseModel](
    config: AgentConfig, schema: type[S], system: str, user: str
) -> S:
    """Ask the model for one `schema` object. Ollama constrains the output to the JSON schema.

    The call is traced in Langfuse when tracing is configured (see `tracing.py`).
    """
    model = chat_model(config).with_structured_output(schema, method="json_schema")
    messages = [("system", system), ("human", user)]
    result = await model.ainvoke(messages, config=langchain_config() or None)
    return schema.model_validate(result)


def load_prompt(service_file: str, name: str) -> str:
    """Read `prompts/<name>.md` from the calling service's package (pass `__file__`)."""
    return (Path(service_file).resolve().parent / "prompts" / f"{name}.md").read_text()


def clip(text: str, max_chars: int) -> str:
    """Trim long posting text so prompt + answer fit the context window."""
    return text if len(text) <= max_chars else text[:max_chars] + "\n[…truncated]"
