---
name: Rate Limiting (Optional)
id: rate-limiting
requires_rebuild: false
timeout: 300
---

## Overview

Tests the `SlidingWindowRateLimiter` by rapidly creating teams via SDK tools. The default limit is `create_team=5` per window.

**This scenario is optional and may be flaky.** Rate limiting is timing-sensitive. If the window is large enough, all requests may succeed. Skip if other scenarios pass cleanly.

## Setup

Clean up any leftover rate-limit test teams:
```bash
for i in 1 2 3 4 5 6 7; do
  curl -s -X DELETE "http://localhost:8080/api/v1/teams/rate-t$i" 2>/dev/null
done
```

## Tests

### 1. Rapid Team Creation

**Run:**
```bash
curl -s -m 180 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Rapidly dispatch 7 create_team calls in succession: for each, use create_agent with a unique name (rate-agent-1 through rate-agent-7) and description \"rate test\", then create_team with slugs rate-t1 through rate-t7. The rate limit is 5 per minute. Report any RATE_LIMITED errors you encounter."}'
```

**Expected:**
- First 5 succeed
- 6th or 7th gets a `RATE_LIMITED` error with `Retry-After` header
- If all succeed (timing window allows), that is also acceptable — mark as PASS with note

## Teardown

```bash
for i in 1 2 3 4 5 6 7; do
  curl -s -X DELETE "http://localhost:8080/api/v1/teams/rate-t$i" 2>/dev/null
done
```
