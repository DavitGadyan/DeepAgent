"""Pure relevance rules: no I/O, so they are trivial to test."""

from __future__ import annotations

import math
from dataclasses import dataclass

from leadscout_common.text import contains_phrase


@dataclass(frozen=True)
class Verdict:
    keep: bool
    reason: str


def keyword_verdict(title: str, keywords: list[str], exclude: list[str]) -> Verdict | None:
    """Decide from the title alone when it is obvious; None means 'ask the embeddings'."""
    lowered = title.lower()
    for phrase in exclude:
        if contains_phrase(lowered, phrase):
            return Verdict(False, f"excluded keyword: {phrase}")
    for phrase in keywords:
        if contains_phrase(lowered, phrase):
            return Verdict(True, f"title matches: {phrase}")
    return None


def description_verdict(description: str, keywords: list[str], min_mentions: int) -> Verdict | None:
    """Rescue an oddly titled job whose text clearly is about the field.

    "Senior Engineer, Recommendation Systems" names no target role, but its posting
    mentions several target phrases. Returns None when there is not enough evidence.
    """
    mentioned = [phrase for phrase in keywords if contains_phrase(description, phrase)]
    # "AI" inside "Generative AI Engineer" is one mention, not two: count outermost phrases.
    distinct = [
        phrase
        for phrase in mentioned
        if not any(other != phrase and contains_phrase(other, phrase) for other in mentioned)
    ]
    if len(distinct) >= min_mentions:
        return Verdict(True, f"description mentions: {', '.join(distinct[:4])}")
    return None


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def similarity_verdict(
    title_vector: list[float],
    target_vectors: dict[str, list[float]],
    other_vectors: dict[str, list[float]],
    min_margin: float,
    min_similarity: float,
) -> Verdict:
    """Keep the posting when its title is close to a target role and closer than to any other.

    Similarity to target roles alone does not separate job titles ("DevOps Engineer" sits
    close to "ML Engineer" because of the shared word), so the main test is the margin
    between the nearest target role and the nearest non-target role. The similarity floor
    catches job families the non-target list does not mention at all.
    """
    target, target_score = _nearest(title_vector, target_vectors)
    other, other_score = _nearest(title_vector, other_vectors)
    margin = target_score - other_score
    if target_score < min_similarity:
        return Verdict(
            False, f"not a target role: closest is '{target}' at only {target_score:.2f}"
        )
    if margin >= min_margin:
        return Verdict(True, f"closest to '{target}' ({margin:+.2f} over '{other}')")
    return Verdict(False, f"not a target role: closer to '{other}' ({-margin:.2f} over '{target}')")


def _nearest(vector: list[float], anchors: dict[str, list[float]]) -> tuple[str, float]:
    scored = ((name, cosine(vector, anchor)) for name, anchor in anchors.items())
    return max(scored, key=lambda pair: pair[1], default=("none", 0.0))
