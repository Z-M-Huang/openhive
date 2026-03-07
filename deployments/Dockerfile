# OpenHive Master Container Image
# TypeScript backend layered on top of the team base image (openhive-team).
#
# Build stages:
#   1. backend-builder: compiles TypeScript backend to JS
#   2. final: team base image + compiled backend + web SPA
#
# Requires: openhive-team image must be built first (Dockerfile.team).
# Web SPA must be pre-built (web/dist) before running docker build.

# ── Stage 1: TypeScript backend build ─────────────────────────────────────
FROM node:22-bookworm-slim AS backend-builder

# better-sqlite3 requires native compilation tools
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.10

WORKDIR /build

# Install dependencies first (layer cache friendly)
COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install --frozen-lockfile

# Copy source and compile
COPY backend/src/ ./backend/src/
COPY backend/tsconfig.json ./backend/

RUN cd backend && bun run build

# ── Stage 2: Master = team image + compiled backend + web SPA ─────────────
FROM openhive-team

# Node.js backend runs as root (PID 1) — needs write access to mounted
# volumes and Docker socket. The agent-runner child process drops to
# the 'node' user (UID 1000) via SysProcAttr.Credential.
USER root

# Copy compiled backend (JS only — no TypeScript source)
COPY --from=backend-builder /build/backend/dist /app/backend/dist
COPY --from=backend-builder /build/backend/node_modules /app/backend/node_modules

# Copy pre-built web SPA (must be built before docker build)
COPY web/dist /app/web/dist

# Copy config data directory (templates and defaults)
COPY data/ /app/data/

# Copy main assistant static directory (CLAUDE.md, skills, settings)
COPY main-assistant/ /app/main-assistant/

# Fixed container paths — volumes mount host dirs to these locations.
ENV OPENHIVE_DATA_DIR=/app/data \
    OPENHIVE_RUN_DIR=/app/run \
    OPENHIVE_SYSTEM_LISTEN_ADDRESS=0.0.0.0:8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:8080/api/v1/health || exit 1

# Node.js backend is PID 1, spawns agent-runner child process
ENTRYPOINT ["node", "backend/dist/index.js"]
