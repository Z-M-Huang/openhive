#!/bin/sh
set -e

# Fix ownership on bind-mounted volumes (host dirs may be root-owned)
chown -R node:node /app/.run /data/config /data/rules 2>/dev/null || true

# Drop to non-root user and exec the app
exec gosu node node dist/entrypoint.js
