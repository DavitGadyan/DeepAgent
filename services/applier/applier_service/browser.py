"""A Chrome window that outlives the agent session, so the filled form stays on screen.

The applier starts Chrome itself with a remote-debugging port and a dedicated profile
(logins persist between applications). The agent's Playwright MCP server only attaches
to it; when the agent exits, the window and the form remain for the human to review.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from pathlib import Path

import httpx

from .settings import ApplierSettings

log = logging.getLogger(__name__)
MCP_SERVER_NAME = "applybrowser"
# Pinned: the guard and the agent instructions were written against this version's tools.
PLAYWRIGHT_MCP_VERSION = "0.0.85"
STARTUP_WAIT_S = 15


async def chrome_is_up(settings: ApplierSettings) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2) as http:
            return (await http.get(f"{settings.cdp_url}/json/version")).status_code == 200
    except httpx.HTTPError:
        return False


async def ensure_chrome(settings: ApplierSettings) -> None:
    """Start the applier's Chrome if it is not already running."""
    if await chrome_is_up(settings):
        return
    settings.chrome_profile_dir.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(  # noqa: S603 - fixed argument list, no shell
        [
            settings.chrome_bin,
            f"--remote-debugging-port={settings.cdp_port}",
            f"--user-data-dir={settings.chrome_profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,  # detached: survives both the agent and this worker
    )
    for _ in range(STARTUP_WAIT_S * 2):
        if await chrome_is_up(settings):
            log.info("Chrome started on %s", settings.cdp_url)
            return
        await asyncio.sleep(0.5)
    raise RuntimeError(f"Chrome did not open its debugging port at {settings.cdp_url}")


def write_mcp_config(settings: ApplierSettings, output_dir: Path) -> Path:
    """MCP config for the agent: Playwright attached to our Chrome, files saved to `output_dir`."""
    config = {
        "mcpServers": {
            MCP_SERVER_NAME: {
                "command": "npx",
                "args": [
                    "--yes",
                    f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}",
                    "--cdp-endpoint",
                    settings.cdp_url,
                    "--output-dir",
                    str(output_dir),
                ],
            }
        }
    }
    path = output_dir / ".mcp-applier.json"
    path.write_text(json.dumps(config, indent=2))
    return path
