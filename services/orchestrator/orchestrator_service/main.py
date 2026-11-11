"""Orchestrator: the API the UI talks to, plus the background task that records events."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from leadscout_common.bus import Bus
from leadscout_common.logs import setup_logging

from .db import create_tables, make_engine, make_session_factory
from .event_log import Broadcaster, supervise_consumer
from .routes import events, leads, runs
from .security import SameOriginWritesMiddleware


def allowed_origins() -> list[str]:
    return os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",")


def allowed_hosts() -> list[str]:
    """Host headers the API answers to; anything else is refused (DNS-rebinding defence)."""
    return os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1,orchestrator").split(",")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging("orchestrator")
    engine = make_engine()
    await create_tables(engine)
    app.state.bus = Bus()
    app.state.sessions = make_session_factory(engine)
    app.state.broadcaster = Broadcaster()
    app.state.consumer = asyncio.create_task(
        supervise_consumer(app.state.bus, app.state.sessions, app.state.broadcaster)
    )
    yield
    app.state.consumer.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.consumer
    await app.state.bus.close()
    await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="LeadScout orchestrator", lifespan=lifespan)
    origins = allowed_origins()
    # Added last runs first: host check, then the cross-site write check, then CORS.
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"]
    )
    app.add_middleware(SameOriginWritesMiddleware, allowed_origins=origins)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts())
    app.include_router(runs.router)
    app.include_router(leads.router)
    app.include_router(events.router)
    return app


app = create_app()
