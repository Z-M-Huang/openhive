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

# Install all dependencies
RUN bun install

# Install Playwright Chromium to a shared path
ENV PLAYWRIGHT_BROWSERS_PATH=/app/browsers
RUN npx playwright install --with-deps chromium

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./
COPY system-rules/ ./system-rules/
COPY seed-rules/ ./seed-rules/

# Compile TypeScript
RUN ./node_modules/.bin/tsc

# Prune devDependencies — only production deps get copied to final image
RUN bun install --production

# ── Production ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# Runtime system dependencies:
#   - curl (health checks, debugging)
#   - Chromium runtime libs (for Playwright browser tools)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl gosu \
        libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
        libxdamage1 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
        libcairo2 libatspi2.0-0 libcups2 libxfixes3 libxkbcommon0 && \
    rm -rf /var/lib/apt/lists/*

# Install bun runtime
RUN npm install -g bun@1.3.10

# Copy compiled app
COPY --from=builder /build/dist/ /app/dist/
COPY --from=builder /build/package.json /app/
COPY --from=builder /build/node_modules/ /app/node_modules/

# Copy Playwright browsers from builder
ENV PLAYWRIGHT_BROWSERS_PATH=/app/browsers
COPY --from=builder /app/browsers /app/browsers

# Dashboard static assets (plain HTML/CSS/JS — no build step needed)
COPY public/ /app/public/

# Tier 1: System rules (baked in, immutable)
COPY --from=builder /build/system-rules/ /app/system-rules/

# Seed rules (copied to /data/rules/ on first start if empty)
COPY --from=builder /build/seed-rules/ /app/seed-rules/

# Create runtime directories
RUN mkdir -p /app/.run /data/config /data/rules

# Ensure non-root user owns app directories
RUN chown -R node:node /app /data
WORKDIR /app

# Docker GID for socket access (override with --build-arg DOCKER_GID=<gid>)
ARG DOCKER_GID=0
RUN if [ "${DOCKER_GID}" = "0" ]; then \
      usermod -aG root node; \
    else \
      groupadd -g ${DOCKER_GID} docker 2>/dev/null || true && \
      usermod -aG docker node 2>/dev/null || \
      usermod -aG ${DOCKER_GID} node 2>/dev/null || true; \
    fi

# Entrypoint: fix bind-mount ownership, then drop to node user via gosu
COPY deployments/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080

ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="OpenHive" \
      org.opencontainers.image.description="AI agent orchestration platform — team-based, tool-augmented, multi-model" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/Z-M-Huang/openhive" \
      org.opencontainers.image.url="https://github.com/Z-M-Huang/openhive" \
      org.opencontainers.image.licenses="GPL-3.0"

ENTRYPOINT ["docker-entrypoint.sh"]
