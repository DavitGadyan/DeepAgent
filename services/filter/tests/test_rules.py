from filter_service.rules import (
    cosine,
    description_verdict,
    keyword_verdict,
    similarity_verdict,
)

KEYWORDS = ["AI Engineer", "Data Scientist"]
EXCLUDE = ["intern"]


def test_title_with_keyword_is_kept() -> None:
    verdict = keyword_verdict("Senior AI Engineer (Remote)", KEYWORDS, EXCLUDE)
    assert verdict is not None and verdict.keep


def test_excluded_word_wins_over_keyword() -> None:
    verdict = keyword_verdict("Data Scientist Intern", KEYWORDS, EXCLUDE)
    assert verdict is not None and not verdict.keep


def test_keywords_match_whole_words_only() -> None:
    assert keyword_verdict("Internal Tools Developer", KEYWORDS, EXCLUDE) is None
    assert keyword_verdict("Maintain Engineering Manager", ["AI"], []) is None


def test_unclear_title_goes_to_embeddings() -> None:
    assert keyword_verdict("Member of Technical Staff, Inference", KEYWORDS, EXCLUDE) is None


def test_margin_between_target_and_other_roles_decides() -> None:
    targets = {"AI Engineer": [1.0, 0.0]}
    others = {"Backend Engineer": [0.0, 1.0]}
    assert similarity_verdict([0.9, 0.2], targets, others, 0.0, 0.6).keep
    assert not similarity_verdict([0.2, 0.9], targets, others, 0.0, 0.6).keep
    assert cosine([1.0, 0.0], [0.0, 0.0]) == 0.0


def test_far_from_every_target_role_is_dropped_even_with_a_margin() -> None:
    targets = {"AI Engineer": [1.0, 0.0]}
    others = {"Backend Engineer": [-1.0, 0.0]}
    assert not similarity_verdict([0.3, 0.95], targets, others, 0.0, 0.6).keep


def test_description_rescues_an_oddly_titled_job() -> None:
    text = "You will train machine learning models, build RAG pipelines and evaluate LLMs."
    keywords = ["Machine Learning", "RAG", "LLMs", "Data Scientist"]
    assert description_verdict(text, keywords, min_mentions=3) is not None
    assert description_verdict("We use machine learning.", keywords, min_mentions=3) is None


def test_nested_phrases_count_once() -> None:
    keywords = ["AI", "Generative AI", "Generative AI Engineer", "ML", "Machine Learning"]
    text = "You will partner with our Generative AI Engineer on the roadmap."

    assert description_verdict(text, keywords, min_mentions=3) is None
