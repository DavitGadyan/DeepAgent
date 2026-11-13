"""Your profile, kept in `data/profile/profile.yaml` so you can also edit it by hand.

The scorer reads its `preferences` and the applier its `application` section, each straight
from the file, so a save here reaches them on their next job without a restart.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import yaml
from leadscout_common.schemas import UserProfile

HEADER = (
    "# Your LeadScout profile. Edited on the Setup page, or by hand. Leave a value empty\n"
    "# rather than guessing: the scorer treats it as no preference, and the job-applier\n"
    "# agent leaves a form question it cannot answer from here blank.\n"
    "# `preferences` is read by the scorer; `application` only by the form-filling agent.\n\n"
)


def profile_path() -> Path:
    return Path(os.environ.get("PROFILE_PATH", "data/profile/profile.yaml"))


def read_profile(path: Path) -> UserProfile:
    """The stored profile; an empty one when the file does not exist yet."""
    if not path.is_file():
        return UserProfile()
    return UserProfile.model_validate(yaml.safe_load(path.read_text()) or {})


def write_profile(path: Path, profile: UserProfile) -> UserProfile:
    """Replace the file in one step, so a reader never sees half a file."""
    text = HEADER + yaml.safe_dump(profile.model_dump(), sort_keys=False, allow_unicode=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".profile-", suffix=".yaml")
    try:
        with os.fdopen(handle, "w") as file:
            file.write(text)
        # mkstemp makes it 0600; the scorer container and the host applier must read it too.
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return profile
