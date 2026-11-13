"""Your profile (preferences and application answers) and the applier's sign-in state."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from leadscout_common.schemas import ApplierStatus, UserProfile
from leadscout_common.shared_state import load_applier_status

from ..deps import BusDep
from ..profile_store import profile_path, read_profile, write_profile

router = APIRouter(prefix="/api")


@router.get("/profile")
async def get_profile() -> UserProfile:
    return await asyncio.to_thread(read_profile, profile_path())


@router.put("/profile")
async def put_profile(profile: UserProfile) -> UserProfile:
    try:
        return await asyncio.to_thread(write_profile, profile_path(), profile)
    except OSError as error:
        raise HTTPException(500, f"Could not save the profile file: {error.strerror}") from None


@router.get("/applier")
async def get_applier_status(bus: BusDep) -> ApplierStatus | None:
    """`null` when the applier worker is not running (`make applier`)."""
    return await load_applier_status(bus)
