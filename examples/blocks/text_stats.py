"""Example custom block for the Agent design validation platform."""

from __future__ import annotations


def text_stats(text: str, lowercase: bool = False) -> dict[str, int | str]:
    """Return simple text statistics with an optional normalized value."""
    normalized = text.lower() if lowercase else text
    return {
        "text": normalized,
        "characters": len(normalized),
        "words": len(normalized.split()),
        "lines": len(normalized.splitlines()) or 1,
    }

