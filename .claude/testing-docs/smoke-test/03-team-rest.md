---
name: Team CRUD via REST API
id: team-rest
requires_rebuild: false
timeout: 120
---

## Overview

Tests team lifecycle through REST endpoints: create, get, list, delete, and validation errors. All teams created here are cleaned up in teardown.

## Setup

Verify no leftover teams from previous scenarios:
```bash
curl -s http://localhost:8080/api/v1/teams
```
If `smoke-rest-team` exists, delete it first.

## Tests

### 1. Teams Empty State

**Run:**
```bash
curl -s http://localhost:8080/api/v1/teams
```

**Expected:**
- `{"data":[]}` — no configured teams (synthetic `main` is excluded from API)

### 2. Create Team

**Run:**
```bash
curl -s -X POST http://localhost:8080/api/v1/teams \
  -H "Content-Type: application/json" \
  -d '{"slug":"smoke-rest-team","leader_aid":"aid-main-001"}'
```

**Expected:**
- HTTP 201
- JSON with `data.slug` = `"smoke-rest-team"`, `data.tid` starts with `tid-`, `data.leader_aid` = `"aid-main-001"`

### 3. Get Team by Slug

**Run:**
```bash
curl -s http://localhost:8080/api/v1/teams/smoke-rest-team
```

**Expected:**
- JSON with `data.slug` = `"smoke-rest-team"`

### 4. List Teams (Non-Empty)

**Run:**
```bash
curl -s http://localhost:8080/api/v1/teams
```

**Expected:**
- Array containing at least `smoke-rest-team`

### 5. Validation — Missing Slug

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/api/v1/teams \
  -H "Content-Type: application/json" \
  -d '{"leader_aid":"aid-test-001"}'
```

**Expected:**
- HTTP 400

### 6. Validation — Missing leader_aid

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/api/v1/teams \
  -H "Content-Type: application/json" \
  -d '{"slug":"test-team"}'
```

**Expected:**
- HTTP 400

### 7. Validation — Reserved Slug

**Run:**
```bash
curl -s -X POST http://localhost:8080/api/v1/teams \
  -H "Content-Type: application/json" \
  -d '{"slug":"main","leader_aid":"aid-test-001"}'
```

**Expected:**
- HTTP 400 with `VALIDATION_ERROR` about reserved slug

### 8. Delete Team

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X DELETE http://localhost:8080/api/v1/teams/smoke-rest-team
```

**Expected:**
- HTTP 204 (No Content)

### 9. Verify Deleted

**Run:**
```bash
curl -s http://localhost:8080/api/v1/teams/smoke-rest-team
```

**Expected:**
- `NOT_FOUND` error

### 10. Delete Non-Existent Team

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X DELETE http://localhost:8080/api/v1/teams/nonexistent-team
```

**Expected:**
- HTTP 404

## Teardown

```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-rest-team 2>/dev/null || true
```
