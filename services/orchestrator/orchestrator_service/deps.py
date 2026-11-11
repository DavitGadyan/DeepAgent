"""FastAPI dependencies: the shared bus, database session and broadcaster."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from leadscout_common.bus import Bus
from sqlalchemy.ext.asyncio import AsyncSession

from .event_log import Broadcaster


def get_bus(request: Request) -> Bus:
    return request.app.state.bus


def get_broadcaster(request: Request) -> Broadcaster:
    return request.app.state.broadcaster


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.sessions() as session:
        yield session


BusDep = Annotated[Bus, Depends(get_bus)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]
BroadcasterDep = Annotated[Broadcaster, Depends(get_broadcaster)]
