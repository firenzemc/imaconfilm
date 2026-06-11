# filmtool — Imacon FFF film-negative developer.
# Apple Silicon / arm64 native (also builds on amd64). Data lives on a mounted
# volume, so `docker save`-ing this image effectively moves the whole tool.
FROM python:3.13-slim

# uv: fast, reproducible installs from the committed uv.lock
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    FILMTOOL_ROOT=/data

# dependency layer (cached unless the lock changes)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# application source
COPY fff.py pipeline.py server.py ./
COPY static ./static

EXPOSE 8790
# Browse/read/write is confined to FILMTOOL_ROOT (=/data, a mounted volume).
CMD ["uv", "run", "--frozen", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8790"]
