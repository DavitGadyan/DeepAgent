from pathlib import Path

import pytest
import yaml
from scout_service.sources import ALL_SOURCES, get_source

SOURCES_YAML = Path(__file__).parents[3] / "config" / "sources.yaml"
EXPECTED = {
    "greenhouse", "lever", "ashby", "remoteok", "remotive", "weworkremotely", "hn_hiring",
    "yc_jobs", "jobicy", "startup_jobs", "teamtailor", "zoho_recruit", "freelancermap",
    "linkedin", "indeed",
}  # fmt: skip


def test_every_adapter_is_registered_once():
    names = [source.name for source in ALL_SOURCES]
    assert len(names) == len(set(names))
    assert set(names) == EXPECTED


def test_adapters_follow_the_source_contract():
    for source in ALL_SOURCES:
        assert source.name == source.name.lower().replace(" ", "_")
        assert source.label
        assert isinstance(source.scraped, bool)
        assert callable(source.fetch)


def test_get_source_looks_up_by_name():
    assert get_source("lever").name == "lever"
    with pytest.raises(KeyError):
        get_source("no_such_source")


def test_sources_yaml_lists_every_adapter_under_enabled():
    config = yaml.safe_load(SOURCES_YAML.read_text())
    assert set(config["enabled"]) == EXPECTED
    assert all(isinstance(flag, bool) for flag in config["enabled"].values())


def test_scraped_adapters_are_disabled_by_default():
    enabled = yaml.safe_load(SOURCES_YAML.read_text())["enabled"]
    for source in ALL_SOURCES:
        assert enabled[source.name] is not source.scraped


def test_settings_sections_belong_to_known_adapters():
    config = yaml.safe_load(SOURCES_YAML.read_text())
    assert set(config) - {"enabled"} <= EXPECTED
