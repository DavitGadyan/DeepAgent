from orchestrator_service.posting_keys import posting_keys, role_key, url_keys


def test_a_job_id_in_the_address_is_the_key_whatever_page_shows_the_job() -> None:
    on_the_board = url_keys("https://job-boards.greenhouse.io/asg/jobs/8919112002")
    on_the_company_site = url_keys("https://careers.nebius.com/job?gh_jid=8919112002&utm=x")

    assert on_the_board == on_the_company_site == {"greenhouse:8919112002"}


def test_each_tracking_system_gives_its_own_key() -> None:
    uuid = "1c0f71a9-6519-4d0f-bb79-5c55022335e4"

    assert url_keys(f"https://jobs.ashbyhq.com/Dandelionhealth/{uuid}") == {f"ashby:{uuid}"}
    assert url_keys(f"https://jobs.lever.co/distru/{uuid}/apply") == {f"lever:{uuid}"}
    assert url_keys("https://apply.workable.com/plainconcepts/j/FFA5610B8A/") == {
        "workable:ffa5610b8a"
    }
    assert url_keys("https://apply.workable.com/j/1C5A7AE862") == {"workable:1c5a7ae862"}
    assert url_keys("https://www.linkedin.com/jobs/view/4486334878/") == {"linkedin:4486334878"}


def test_an_address_without_a_job_id_is_its_host_and_path() -> None:
    assert url_keys("https://www.Example.com/Careers/ai-engineer/?ref=board#apply") == {
        "url:example.com/careers/ai-engineer"
    }
    assert url_keys("  ") == set()


def test_the_role_key_ignores_case_and_punctuation() -> None:
    assert role_key("Shield AI", "Staff Deep-Learning Engineer (R5785)") == (
        "role:shield ai|staff deep learning engineer r5785"
    )
    assert role_key("", "AI Engineer") == ""
    assert role_key("Acme", " - ") == ""


def test_a_posting_has_the_keys_of_all_its_addresses_and_of_its_role() -> None:
    keys = posting_keys(
        ["https://toloka.ai/careers/info?jid=1&gh_jid=4909630101", "https://toloka.ai/careers"],
        "Toloka",
        "Forward Deployed AI Engineer",
    )

    assert keys == {
        "greenhouse:4909630101",
        "url:toloka.ai/careers",
        "role:toloka|forward deployed ai engineer",
    }
