import json
from pathlib import Path

import pytest
from scorer_service.profile import load_profile


def test_only_preferences_reach_the_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "cv.txt").write_text("Data Scientist, 8 years, Python")
    (tmp_path / "profile.yaml").write_text(
        "preferences:\n  remote: remote only\n  avoid: ''\n"
        "application:\n  phone: '+34 600 000 000'\n"
    )
    monkeypatch.setenv("PROFILE_CV_PATH", str(tmp_path / "cv.txt"))
    monkeypatch.setenv("PROFILE_PREFS_PATH", str(tmp_path / "profile.yaml"))

    prompt = load_profile().as_prompt()

    assert "Data Scientist, 8 years" in prompt
    assert "remote: remote only" in prompt
    assert "600 000" not in prompt  # form data never goes to the model
    assert "avoid" not in prompt  # empty preferences are omitted


def test_missing_cv_is_a_hard_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PROFILE_CV_PATH", str(tmp_path / "nope.txt"))
    with pytest.raises(FileNotFoundError):
        load_profile()


def test_portfolio_catalogue_adds_skills_most_used_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "cv.txt").write_text("Data Scientist")
    catalogue = {
        "profile": {"positioning": "Builds AI systems.", "services": ["Machine Learning"]},
        "index_by_skill": {"LangChain": ["a"], "Python": ["a", "b", "c"]},
    }
    (tmp_path / "catalogue.json").write_text(json.dumps(catalogue))
    monkeypatch.setenv("PROFILE_CV_PATH", str(tmp_path / "cv.txt"))
    monkeypatch.setenv("PROFILE_CATALOGUE_PATH", str(tmp_path / "catalogue.json"))
    monkeypatch.setenv("PROFILE_PREFS_PATH", str(tmp_path / "none.yaml"))

    prompt = load_profile().as_prompt()

    assert "Python (3), LangChain (1)" in prompt
    assert "Builds AI systems." in prompt


def test_level_comes_from_stated_seniority_or_years(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "cv.txt").write_text("cv")
    monkeypatch.setenv("PROFILE_CV_PATH", str(tmp_path / "cv.txt"))
    monkeypatch.setenv("PROFILE_PREFS_PATH", str(tmp_path / "profile.yaml"))

    (tmp_path / "profile.yaml").write_text("preferences:\n  seniority: senior or lead\n")
    assert load_profile().level == "lead"

    (tmp_path / "profile.yaml").write_text("application:\n  years_of_experience: '8'\n")
    profile = load_profile()
    assert profile.level == "senior"
    assert profile.candidate.has_preferences is False


def test_evidence_includes_every_portfolio_skill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "cv.txt").write_text("Data Scientist")
    names = {f"Skill{i}": ["p"] for i in range(100)} | {"Pinecone": ["p"]}
    catalogue = {"index_by_skill": names, "profile": {"core_stack": {"ml": ["scikit-learn"]}}}
    (tmp_path / "catalogue.json").write_text(json.dumps(catalogue))
    monkeypatch.setenv("PROFILE_CV_PATH", str(tmp_path / "cv.txt"))
    monkeypatch.setenv("PROFILE_CATALOGUE_PATH", str(tmp_path / "catalogue.json"))
    monkeypatch.setenv("PROFILE_PREFS_PATH", str(tmp_path / "none.yaml"))

    profile = load_profile()

    assert "Pinecone" in profile.evidence and "scikit-learn" in profile.evidence
    assert "Pinecone" not in profile.as_prompt()  # beyond the 80 most used: not in the prompt
