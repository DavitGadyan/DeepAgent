# One image recipe for every Python service; each service is still its own image and container.
#   docker build -f docker/service.Dockerfile --build-arg SERVICE=scorer .
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
ARG SERVICE
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
COPY packages/common packages/common
COPY services/${SERVICE} services/${SERVICE}
# Installs this service and the shared package only, pinned by the workspace lock file.
RUN uv sync --frozen --no-dev --no-editable --package ${SERVICE}-service

FROM python:3.12-slim
ARG SERVICE
RUN useradd --create-home --uid 1000 app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --chown=app config /app/config
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 LEADSCOUT_CONFIG_DIR=/app/config SERVICE=${SERVICE}
USER app
CMD ["sh", "-c", "exec python -m ${SERVICE}_service.main"]
