"""The applier's output folders as this process sees them (a read-only mount)."""

from __future__ import annotations

import os
from pathlib import Path

SENT_DOCUMENTS = "*.pdf"


def applications_dir() -> Path:
    """Where the application folders are: one folder per application, named by the applier."""
    return Path(os.environ.get("APPLICATIONS_DIR", "data/applications")).resolve()


def sent_documents(folder: str) -> list[str]:
    """Names of the documents in an application's folder; none when the folder is not there."""
    root = applications_dir()
    path = (root / folder).resolve()
    if not folder or not path.is_relative_to(root) or not path.is_dir():
        return []
    return sorted(document.name for document in path.glob(SENT_DOCUMENTS))
