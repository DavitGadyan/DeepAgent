"""Researcher: the model sees only its two tools, and tools never raise into the agent."""

import json
from typing import Any

import pytest
import respx
from langchain_core.language_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from leadscout_common.config import AgentConfig
from leadscout_common.schemas import CompanyBrief, JobMessage, JobPosting
from researcher_service import agent as researcher
from researcher_service import tools

MESSAGE = JobMessage(
    run_id="r",
    job=JobPosting(source="t", url="https://x.test", title="AI Engineer", company="Acme"),
)


class ScriptedModel(GenericFakeChatModel):
    """Plays back tool calls and records the tools it was offered."""

    model: str = "qwen3:14b"
    offered: list[str] = []

    def _get_ls_params(self, stop: Any = None, **kwargs: Any) -> Any:
        return {"ls_provider": "ollama", "ls_model_name": self.model, "ls_model_type": "chat"}

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        self.offered[:] = [getattr(t, "name", None) or t.__name__ for t in tools]
        return self


async def test_model_is_offered_only_its_own_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "searxng_url", lambda: "http://searxng.test")
    script = iter(
        [
            AIMessage(
                content="",
                tool_calls=[{"name": "web_search", "args": {"query": "Acme"}, "id": "1"}],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "CompanyBrief",
                        "args": {"what_they_do": "Agents.", "sources": ["https://acme.test"]},
                        "id": "2",
                    }
                ],
            ),
        ]
    )
    model = ScriptedModel(messages=script)
    monkeypatch.setattr(researcher, "chat_model", lambda config: model)
    agent = researcher.build_agent(AgentConfig(model="qwen3:14b", timeout_s=30))

    with respx.mock:
        respx.get("http://searxng.test/search").respond(
            json={"results": [{"title": "Acme", "url": "https://acme.test", "content": "x"}]}
        )
        brief = await researcher.research(agent, MESSAGE, AgentConfig(timeout_s=30))

    assert sorted(model.offered) == ["CompanyBrief", "fetch_page", "web_search"]
    assert brief == CompanyBrief(what_they_do="Agents.", sources=["https://acme.test"])


@respx.mock
async def test_search_outage_is_not_reported_as_no_results(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "searxng_url", lambda: "http://searxng.test")
    respx.get("http://searxng.test/search").respond(
        json={"results": [], "unresponsive_engines": [["duckduckgo", "CAPTCHA"]]}
    )

    answer = await tools.web_search.ainvoke({"query": "Acme"})

    assert answer.startswith("Search failed") and "duckduckgo: CAPTCHA" in answer


@respx.mock
async def test_search_errors_come_back_as_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "searxng_url", lambda: "http://searxng.test")
    respx.get("http://searxng.test/search").respond(status_code=503)

    assert (await tools.web_search.ainvoke({"query": "Acme"})).startswith("Search failed")


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "http://127.0.0.1:8000/api/leads", "http://[::1", "https://a..b/x"],
)
async def test_fetch_refuses_private_and_malformed_urls(url: str) -> None:
    assert (await tools.fetch_page.ainvoke({"url": url})).startswith("Refused")


@respx.mock
async def test_a_redirect_to_a_private_address_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "is_public_url", lambda url: "127.0.0.1" not in url)
    respx.get("https://acme.test/").respond(301, headers={"location": "http://127.0.0.1:8000/"})
    internal = respx.get("http://127.0.0.1:8000/").respond(200, text="secret")

    assert (await tools.fetch_page.ainvoke({"url": "https://acme.test/"})).startswith("Refused")
    assert not internal.called


@respx.mock
async def test_non_html_pages_are_not_dumped_as_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "is_public_url", lambda url: True)
    respx.get("https://acme.test/report.pdf").respond(
        200, content=b"%PDF-1.7", headers={"content-type": "application/pdf"}
    )

    answer = await tools.fetch_page.ainvoke({"url": "https://acme.test/report.pdf"})

    assert answer == "Not a readable page (it is application/pdf)."


def test_page_text_keeps_forms_and_headers() -> None:
    markup = (
        "<body><header><h1>Acme: AI agents for banks</h1></header>"
        "<form id='f'><p>We sell to factories.</p><input value='x'></form><script>1</script></body>"
    )

    assert tools.page_text(markup) == "Acme: AI agents for banks\nWe sell to factories."


def test_search_failure_text_is_json_safe() -> None:
    json.dumps(tools.search_failure({"unresponsive_engines": [["brave", "timeout"]]}))


async def test_an_empty_brief_is_filled_from_what_the_tools_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from langchain_core.messages import ToolMessage

    class Agent:
        async def ainvoke(self, request: Any, config: Any) -> dict:
            page = ToolMessage(
                content="Acme builds AI agents for insurers.", name="fetch_page", tool_call_id="1"
            )
            return {
                "messages": [page, AIMessage(content="done")],
                "structured_response": CompanyBrief(sources=["https://acme.test"]),
            }

    seen = {}

    async def fake_call(config: Any, schema: Any, system: str, user: str) -> CompanyBrief:
        seen["user"] = user
        return CompanyBrief(what_they_do="AI agents for insurers.")

    monkeypatch.setattr(researcher, "structured_call", fake_call)

    brief = await researcher.research(Agent(), MESSAGE, AgentConfig(timeout_s=30))

    assert "Acme builds AI agents for insurers." in seen["user"]
    assert brief.what_they_do == "AI agents for insurers."
    assert brief.sources == ["https://acme.test"]
