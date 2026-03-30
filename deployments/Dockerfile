# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Install native build tools for better-sqlite3 and bun runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        curl \
        unzip && \
    rm -rf /var/lib/apt/lists/*

# Install bun
RUN npm install -g bun@1.3.10

# Copy package files first (layer cache)
COPY package.json bun.lock* ./
COPY backend/package.json backend/

# Install all dependencies
RUN bun install

# Install Playwright Chromium to a shared path
ENV PLAYWRIGHT_BROWSERS_PATH=/app/browsers
RUN cd backend && npx playwright install --with-deps chromium

# Copy source code
COPY backend/src backend/src
COPY backend/tsconfig.json backend/
COPY common/ /build/common/

# Compile TypeScript
RUN cd backend && ./node_modules/.bin/tsc

# ── Production ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# Runtime system dependencies:
#   - curl (health checks, debugging)
#   - Chromium runtime libs (for Playwright browser tools)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
        libxdamage1 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
        libcairo2 libatspi2.0-0 libcups2 libxfixes3 libxkbcommon0 && \
    rm -rf /var/lib/apt/lists/*

# Install bun runtime
RUN npm install -g bun@1.3.10

# Copy compiled backend
COPY --from=builder /build/backend/dist/ /app/backend/dist/
COPY --from=builder /build/backend/package.json /app/backend/
COPY --from=builder /build/package.json /app/
COPY --from=builder /build/node_modules/ /app/node_modules/
COPY --from=builder /build/backend/node_modules/ /app/backend/node_modules/

# Copy Playwright browsers from builder
ENV PLAYWRIGHT_BROWSERS_PATH=/app/browsers
COPY --from=builder /app/browsers /app/browsers

# Tier 1: System rules (baked in, immutable)
COPY --from=builder /build/common/system-rules/ /app/system-rules/

# Seed rules (copied to /data/rules/ on first start if empty)
COPY --from=builder /build/common/seed-rules/ /app/seed-rules/

# Create runtime directories
RUN mkdir -p /app/.run /data/config /data/rules

# Ensure non-root user owns app directories
RUN chown -R node:node /app /data
WORKDIR /app/backend

# Docker GID for socket access (override with --build-arg DOCKER_GID=<gid>)
ARG DOCKER_GID=0
RUN if [ "${DOCKER_GID}" = "0" ]; then \
      usermod -aG root node; \
    else \
      groupadd -g ${DOCKER_GID} docker 2>/dev/null || true && \
      usermod -aG docker node 2>/dev/null || \
      usermod -aG ${DOCKER_GID} node 2>/dev/null || true; \
    fi

# Switch to non-root user
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080

CMD ["node", "dist/entrypoint.js"]
