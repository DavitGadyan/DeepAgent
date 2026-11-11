import pytest
from leadscout_common import config

AGENTS_TOML = """
[agents.filter]
model = "bge-m3"
embedding = true
min_margin = 0.1

[agents.scorer]
model = "qwen3:14b"
num_ctx = 16384

[agents.researcher]
model = "qwen3:14b"
num_ctx = 16384
min_num_ctx = 8192
timeout_s = 600
"""


@pytest.fixture(autouse=True)
def config_files(tmp_path, monkeypatch):
    (tmp_path / "agents.toml").write_text(AGENTS_TOML)
    monkeypatch.setenv("LEADSCOUT_CONFIG_DIR", str(tmp_path))
    names = ["LEADSCOUT_MODEL", "LEADSCOUT_NUM_CTX", "LEADSCOUT_TIMEOUT_S"]
    names += [
        f"{a}_{s}" for a in ("SCORER", "RESEARCHER") for s in ("MODEL", "NUM_CTX", "TIMEOUT_S")
    ]
    for name in names:
        monkeypatch.delenv(name, raising=False)
    config._agents_file.cache_clear()
    yield
    config._agents_file.cache_clear()


def test_defaults_come_from_the_file_and_extras_become_options() -> None:
    assert config.agent_config("scorer").num_ctx == 16384
    assert config.agent_config("filter").options["min_margin"] == 0.1


def test_shared_override_changes_chat_models_only(monkeypatch) -> None:
    monkeypatch.setenv("LEADSCOUT_MODEL", "qwen2.5:7b")

    assert config.agent_config("scorer").model == "qwen2.5:7b"
    assert config.agent_config("filter").model == "bge-m3"  # embeddings keep their model
    assert config.agent_config("scout").model == ""  # no model stays no model


def test_agent_override_wins(monkeypatch) -> None:
    monkeypatch.setenv("LEADSCOUT_MODEL", "qwen2.5:7b")
    monkeypatch.setenv("SCORER_MODEL", "deepseek-r1:14b")

    assert config.agent_config("scorer").model == "deepseek-r1:14b"


def test_per_agent_settings_beat_shared_ones(monkeypatch) -> None:
    monkeypatch.setenv("LEADSCOUT_TIMEOUT_S", "900")
    monkeypatch.setenv("RESEARCHER_TIMEOUT_S", "3000")

    assert config.agent_config("scorer").timeout_s == 900
    assert config.agent_config("researcher").timeout_s == 3000


def test_a_shared_context_size_cannot_go_below_an_agents_floor(monkeypatch) -> None:
    monkeypatch.setenv("LEADSCOUT_NUM_CTX", "4096")

    assert config.agent_config("scorer").num_ctx == 4096
    assert config.agent_config("researcher").num_ctx == 8192
