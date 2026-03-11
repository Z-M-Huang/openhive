# =============================================================================
# OpenHive v2 Multi-Stage Dockerfile
# FR14/AC16: Compiled JS + production deps only. No TypeScript source in final.
#
# Single image for all containers (root and non-root).
# Claude Code CLI installed as non-root 'node' user (UID 1000) —
# Claude Code refuses --dangerously-skip-permissions as root.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Builder -- install deps, compile TypeScript, build SPA
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Install bun (pinned for reproducible builds)
RUN npm install -g bun@1.3.10

# Copy workspace-level package files first (layer cache optimisation)
COPY package.json bun.lock ./
COPY backend/package.json backend/
COPY web/package.json web/

# Install all dependencies (including devDependencies for compilation)
RUN bun install --frozen-lockfile

# Copy source code
COPY backend/ backend/
COPY web/ web/
COPY common/ common/

# Compile backend TypeScript -> JS
RUN cd backend && bun run build

# Build web SPA (vite)
RUN cd web && bun run build

# Prune devDependencies for production image
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Stage 2: Final -- slim runtime with compiled output only
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

# Install runtime system dependencies:
#   - Python 3 with pip + venv (for Claude Agent SDK / tool use)
#   - curl (health checks, debugging)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        curl && \
    rm -rf /var/lib/apt/lists/*

# Install bun runtime (pinned)
RUN npm install -g bun@1.3.10

# Install Claude Code CLI as non-root 'node' user (UID 1000).
# Claude Code refuses --dangerously-skip-permissions when running as root.
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.claude/bin:$PATH"

USER root
WORKDIR /app

# Copy compiled backend JS (no TypeScript source -- NFR13)
COPY --from=builder /build/backend/dist/ backend/dist/
COPY --from=builder /build/backend/package.json backend/

# Copy web SPA bundle
COPY --from=builder /build/web/dist/ web/dist/

# Copy production node_modules (no devDependencies)
COPY --from=builder /build/node_modules/ node_modules/
COPY --from=builder /build/backend/node_modules/ backend/node_modules/
COPY --from=builder /build/package.json .

# Copy common/ folder (skills, scripts, templates) -- AC16
COPY common/ /app/common/

# Ensure non-root user owns app directories
RUN chown -R node:node /app

# Switch to non-root user for runtime
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:8080/api/v1/health || exit 1

CMD ["node", "backend/dist/index.js"]
