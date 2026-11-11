"""Same log format in every container."""

import logging
import os


def setup_logging(service: str) -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format=f"%(asctime)s %(levelname)s {service} %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
