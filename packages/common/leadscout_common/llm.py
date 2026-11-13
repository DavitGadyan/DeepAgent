"""One place that builds chat models, so every agent talks to the model server the same way.

Two servers are supported (`LLM_PROVIDER`): Ollama, and any OpenAI-compatible server such
as vLLM.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from langchain_core.language_models import BaseChatModel

# Both imported here, not when the first job arrives: importing them takes seconds, and
# doing that inside the event loop stalls every worker of the agent (seen on a loaded
# machine: another worker's Redis write timed out meanwhile).
from langchain_ollama import ChatOllama
from langchain_openai import ChatOpenAI
from pydantic import BaseModel

from .config import AgentConfig, llm_server
from .tracing import langchain_config

CONNECT_TIMEOUT_S = 10


def chat_model(config: AgentConfig) -> BaseChatModel:
    """A chat model with an explicit context window.

    `profile` tells LangChain/deepagents the window; without it their summarisation
    assumes 170k tokens. A short connect timeout reports an unreachable host in seconds.
    """
    server = llm_server()
    timeout = httpx.Timeout(config.timeout_s, connect=CONNECT_TIMEOUT_S)
    profile = {"max_input_tokens": config.num_ctx}
    if server.provider == "openai":
        # The window is fixed when the server starts (vLLM: --max-model-len); `num_ctx`
        # must not be larger than that. Retries are ours (`retry.py`), not the client's.
        return ChatOpenAI(
            model=config.model,
            base_url=server.base_url,
            api_key=server.api_key or "not-needed",
            temperature=config.temperature,
            timeout=timeout,
            max_retries=0,
            # Qwen3 thinks by default; the tokens cost time and are not needed here.
            # A chat template without the switch ignores it.
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            profile=profile,
        )

    # Ollama defaults to a 4k context on GPUs under 24 GB and silently truncates longer
    # prompts, so `num_ctx` is always sent.
    return ChatOllama(
        model=config.model,
        base_url=server.base_url,
        num_ctx=config.num_ctx,
        temperature=config.temperature,
        reasoning=False,
        client_kwargs={"timeout": timeout},
        profile=profile,
    )


async def structured_call[S: BaseModel](
    config: AgentConfig, schema: type[S], system: str, user: str
) -> S:
    """Ask the model for one `schema` object. The server constrains the output to the JSON
    schema (Ollama: structured outputs; vLLM: guided decoding).

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
