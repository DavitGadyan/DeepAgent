"""Registry of job sources: one instance of every adapter in this package."""

from __future__ import annotations

from .ashby import AshbySource
from .base import Source
from .freelancermap import FreelancermapSource
from .greenhouse import GreenhouseSource
from .hn_hiring import HnHiringSource
from .indeed import IndeedSource
from .jobicy import JobicySource
from .lever import LeverSource
from .linkedin import LinkedInSource
from .remoteok import RemoteOkSource
from .remotive import RemotiveSource
from .startup_jobs import StartupJobsSource
from .teamtailor import TeamtailorSource
from .weworkremotely import WeWorkRemotelySource
from .yc_jobs import YcJobsSource
from .zoho_recruit import ZohoRecruitSource

ALL_SOURCES: list[Source] = [
    GreenhouseSource(),
    LeverSource(),
    AshbySource(),
    RemoteOkSource(),
    RemotiveSource(),
    WeWorkRemotelySource(),
    HnHiringSource(),
    YcJobsSource(),
    JobicySource(),
    StartupJobsSource(),
    TeamtailorSource(),
    ZohoRecruitSource(),
    FreelancermapSource(),
    LinkedInSource(),
    IndeedSource(),
]

_BY_NAME: dict[str, Source] = {source.name: source for source in ALL_SOURCES}


def get_source(name: str) -> Source:
    """The adapter registered under `name`; raises KeyError for an unknown name."""
    return _BY_NAME[name]
