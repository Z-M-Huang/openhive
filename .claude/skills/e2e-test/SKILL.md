---
name: e2e-test
description: Investigative QA for OpenHive. Acts as a skeptical QA engineer — sends messages via persistent WS harness, independently verifies side effects, investigates failures.
user-invocable: true
---

# OpenHive Investigative QA

You are a **skeptical QA engineer**. Assume nothing works until you prove it does. After every AI response, independently verify filesystem and database state. When something fails, investigate WHY — don't just report "FAIL."

**Critical constraint:** Each WS message spawns a FRESH server-side session. There is NO multi-turn conversation state. The persistent WS connection is client-side convenience only. "Memory" between messages works ONLY through MEMORY.md file persistence + system injection. Design all checks around this reality.

**Run everything autonomously. Never stop to ask the user if you should proceed.**

**CRITICAL: If Phase A has ANY failures, STOP and investigate root causes before proceeding to Phase B. Do not move on with broken infrastructure.**

---

## How You Test

You are a **conversational driver**, not a script generator. You send messages via `curl` to the WS harness (`localhost:9876`), read the JSON response, and verify side effects independently via DB queries and filesystem checks.

**Workflow per test step:**
1. **Send** — `curl localhost:9876/send -d '{"name":"...","content":"...","timeout":300000}'`
2. **Read response** — Check `.ok`, `.final`, `.exchange` array
3. **Verify independently** — DB queries, filesystem reads, docker logs
4. **Check notifications** — `curl localhost:9876/notifications -d '{"name":"..."}'` after every exchange
5. **Investigate failures** — When something fails, send a follow-up diagnostic question on the same connection. Note: each message is still a fresh session — provide full context in the follow-up message itself.

**Never generate `.cjs` scripts.** All WS interaction goes through the harness.

---

## Execution Plan

### Step 1: Setup

Read and execute `.claude/docs/e2e/setup.md` (build, start, wait for health, start harness, connect "main").

### Step 2: Phase A — Smoke Checks

Read and execute `.claude/docs/e2e/smoke-checks.md` (22 deterministic checks).

**STOP GATE:** All 22 must pass (or failures understood) before continuing. If browser checks 21-22 fail, browser scenarios 7-10 are skipped.

### Step 3: Phase B — Investigative QA Scenarios

For each scenario: SEND → READ RESPONSE → VERIFY INDEPENDENTLY → INVESTIGATE → REPORT.

After every AI response, independently check filesystem + database. Don't trust the AI's claims — verify them.

**Between scenarios:** Run the Clean Restart Helper, then reset the harness and reconnect:
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

**After `docker restart openhive`** (mid-scenario restart, NOT clean restart):
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```
Reconnect any other named connections too.

**Scenario 1 — Core Platform:** Read and execute `.claude/docs/e2e/scenario-1-core.md`
(Identity, memory persistence, skill/rule/memory injection, recovery)

**Scenario 2 — Team Lifecycle & Credentials:** Read and execute `.claude/docs/e2e/scenario-2-teams.md`
(Team creation, credential security, get_credential, write scrubbing, tool availability, user journey, recovery, shutdown)

**Scenario 3 — Multi-Team & Hierarchy:** Read and execute `.claude/docs/e2e/scenario-3-hierarchy.md`
(Sibling teams, list_teams routing, child team hierarchy, error handling, shutdown cascade)

**Scenario 4 — Scheduled Jobs & Notifications:** Read and execute `.claude/docs/e2e/scenario-4-triggers.md`
(Trigger setup via create_trigger + enable_trigger MCP tools, cron firing, task result capture, WS notifications, credential protection, trigger persistence across restart)

**Scenario 5 — Stress & Recovery:** Read and execute `.claude/docs/e2e/scenario-5-stress.md`
(5 concurrent messages, per-socket serialization, restart recovery, system stability)

**Scenario 6 — Progressive WS Responses:** Read and execute `.claude/docs/e2e/scenario-6-protocol.md`
(Message types ack/progress/response, ordering, error protocol, JSON structure)

**Scenario 7 — Browser Tool Gating:** Read and execute `.claude/docs/e2e/scenario-7-browser-gating.md`
(Pre-flight, Gate 1 MCP registration, Gate 2 allowed_tools, domain allowlist, graceful degradation)

**Scenario 8 — Browser Operations:** Read and execute `.claude/docs/e2e/scenario-8-browser-ops.md`
(Navigation + snapshot, screenshot ImageContent, SSRF protection for metadata/localhost/RFC1918)

**Scenario 9 — Browser Isolation:** Read and execute `.claude/docs/e2e/scenario-9-browser-isolation.md`
(Two teams with different domain allowlists, cross-team domain isolation, delegation + file write)

**Scenario 10 — Browser Lifecycle:** Read and execute `.claude/docs/e2e/scenario-10-browser-lifecycle.md`
(Idle TTL cleanup, on-demand re-spawn, restart persistence — continues from Scenario 9, NO clean restart)

**NOTE:** If smoke checks 21-22 (browser relay) failed, skip scenarios 7-10 entirely.

### Step 4: Cleanup

```bash
curl -s localhost:9876/shutdown
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1
```

### Step 5: Final Report

```
=== OpenHive QA Investigation Report ===

Phase A: Smoke Checks
  N/22 passed
  Failures: [list with evidence]

Phase B: Investigative Scenarios
  Scenario 1 (Core Platform):           [summary + evidence]
    - Identity: [pass/fail]
    - Tools listed (incl. get_credential): [pass/fail]
    - Memory persistence: [pass/fail]
    - Injection (skill/rule/memory): [pass/fail]
    - Injection removal: [pass/fail]
  Scenario 2 (Team Lifecycle & Credentials): [summary + evidence]
    - Team creation artifacts: [pass/fail]
    - Credential security (not in prompt/logs/WS responses): [pass/fail]
    - get_credential tool works: [pass/fail]
    - Write/Edit scrubbing ([CREDENTIAL:KEY] on disk): [pass/fail]
    - Bash credential guard (file-write denied): [pass/fail]
    - Runtime credential prompt check (agent sees NONE): [pass/fail]
    - Tool availability runtime exercise (Bash works): [pass/fail]
    - Bootstrap: [pass/fail]
    - Task delegation + result capture: [pass/fail]
    - Recovery: [pass/fail]
    - Shutdown: [pass/fail]
  Scenario 3 (Multi-Team & Routing):     [summary + evidence]
    - Sibling creation: [pass/fail]
    - list_teams + routing: [pass/fail]
    - Hierarchy (child team): [pass/fail]
    - Error handling: [pass/fail]
    - Shutdown cascade: [pass/fail]
  Scenario 4 (Scheduled Jobs & Notifications): [summary + evidence]
    - Team + trigger setup: [pass/fail]
    - Trigger firing: [pass/fail]
    - Task result captured: [pass/fail]
    - WS notification received: [pass/fail]
    - Notification content correct: [pass/fail]
    - Credential protection (logs + DB + notifications): [pass/fail]
    - Notification routing isolation (sourceChannelId): [pass/fail]
    - Trigger survives restart: [pass/fail]
    - Post-restart trigger fires: [pass/fail]
  Scenario 5 (Stress & Recovery):        [summary + evidence]
    - Concurrent messages: [pass/fail]
    - Per-socket request serialization: [pass/fail]
    - Post-restart state: [pass/fail]
    - System stability: [pass/fail]
  Scenario 6 (Progressive WS Responses): [summary + evidence]
    - Message types present (ack/progress/response): [pass/fail]
    - Ack is AI-generated (not static): [pass/fail]
    - Ack before response ordering: [pass/fail]
    - Simple request protocol: [pass/fail]
    - Error messages follow protocol: [pass/fail]
    - JSON structure consistency: [pass/fail]
  Scenarios 7-10 (Browser): Mark "skipped" if smoke checks 21-22 failed.
  Scenario 7 (Browser Gating):          [summary + evidence]
    - Pre-flight (@playwright/mcp installed): [pass/fail/skipped]
    - Gate 1 (MCP registration — browser: config): [pass/fail/skipped]
    - Gate 2 (allowed_tools restriction): [pass/fail/skipped]
    - Domain allowlist (allowed vs blocked): [pass/fail/skipped]
    - Graceful degradation: [pass/fail/skipped]
  Scenario 8 (Browser Operations):      [summary + evidence]
    - Navigation + accessibility snapshot: [pass/fail/skipped]
    - Screenshot (ImageContent passthrough): [pass/fail/skipped]
    - SSRF metadata endpoint (169.254.169.254): [pass/fail/skipped]
    - SSRF localhost (127.0.0.1): [pass/fail/skipped]
    - SSRF RFC1918 (10.0.0.1): [pass/fail/skipped]
  Scenario 9 (Browser Isolation):       [summary + evidence]
    - Two separate relay processes: [pass/fail/skipped]
    - Domain isolation (cross-team blocked): [pass/fail/skipped]
    - Process isolation (separate PIDs): [pass/fail/skipped]
    - Delegation + browser + file write: [pass/fail/skipped]
    - Main team without browser: [pass/fail/skipped]
  Scenario 10 (Browser Lifecycle):      [summary + evidence]
    - Idle TTL cleanup (processes killed): [pass/fail/skipped]
    - On-demand re-spawn after cleanup: [pass/fail/skipped]
    - Config survived restart: [pass/fail/skipped]
    - Org tree survived restart: [pass/fail/skipped]
    - Browser tools functional after restart: [pass/fail/skipped]

Critical Findings:
  [List any bugs found with root cause analysis]

Recommendations:
  [What should be fixed before production]
```
