# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

# Install bun
RUN apt-get update && apt-get install -y curl unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/tsconfig.json ./backend/
COPY package.json ./
RUN cd /app && bun install

COPY backend/src ./backend/src
RUN cd /app/backend && npx tsc

# ── Production ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/package.json ./backend/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/node_modules ./backend/node_modules

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || kill -0 1

EXPOSE 8080

CMD ["node", "backend/dist/index.js"]
