---
name: Webhook Endpoints — Error Paths
id: webhooks
requires_rebuild: false
timeout: 60
---

## Overview

Tests the webhook trigger endpoint (`POST /api/v1/hooks/:path`). Only error paths are testable — there is no SDK tool or REST endpoint to create webhook triggers, so the happy path (seeding a trigger and firing it) is covered by unit tests only.

## Setup

None.

## Tests

### 1. Unknown Webhook Path (404)

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/api/v1/hooks/nonexistent-webhook \
  -H "Content-Type: application/json" \
  -d '{"ignored":"body"}'
```

**Expected:**
- HTTP 404 — no webhook trigger configured for this path

### 2. Path Traversal Rejection

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:8080/api/v1/hooks/../etc/passwd" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected:**
- HTTP 400 or 404 — path traversal rejected

## Teardown

None.
