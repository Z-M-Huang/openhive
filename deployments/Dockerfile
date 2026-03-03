# OpenHive Master Container Image
# Go binary layered on top of the team base image (openhive-team).
#
# Build stages:
#   1. go-builder: compiles Go binary with CGO (for SQLite)
#   2. final: team base image + Go binary
#
# Requires: openhive-team image must be built first (Dockerfile.team).

# ── Stage 1: Go build ───────────────────────────────────────────────────
FROM golang:1.26-bookworm AS go-builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/

# CGO required for SQLite (go-sqlite3)
RUN CGO_ENABLED=1 go build -o /out/openhive ./cmd/openhive

# ── Stage 2: Master = team image + Go binary ─────────────────────────────
FROM openhive-team

# Go binary runs as root (PID 1) — needs write access to mounted volumes
# and Docker socket. The agent-runner child process drops to 'node' user.
USER root

COPY --from=go-builder /out/openhive /usr/local/bin/openhive

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:8080/api/v1/health || exit 1

# Go binary is PID 1, spawns Node.js orchestrator as child process
ENTRYPOINT ["/usr/local/bin/openhive"]
