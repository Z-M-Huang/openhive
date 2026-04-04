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

### Step 3: Phase B — Investigative QA Suites

7 test suites, each consolidating related scenarios. For each suite: SEND → READ RESPONSE → RUN VERIFICATION SCRIPT → INVESTIGATE FAILURES → REPORT.

After every AI response, run the suite's verification script. Don't trust the AI's claims — verify them with scripts.

**Verification script pattern:**
```bash
node src/e2e/verify-suite-teams-hierarchy.cjs --step after-team-create
```
Returns JSON: `{ suite, step, checks: [{name, pass, expected, actual}], summary: {total, passed, failed} }`.
If `summary.failed > 0`, investigate the failing checks. If all pass, proceed to next step.

**Between suites:** Run the Clean Restart Helper, then reset the harness and reconnect:
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

**After `docker restart openhive`** (mid-suite restart, NOT clean restart):
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```
Reconnect any other named connections too.

**Suite A — Teams + Hierarchy + Memory:** Read and execute `.claude/docs/e2e/suite-a-teams-hierarchy.md`
(Memory write/persist, team creation, credentials, get_credential, scrubbing, hierarchy, siblings, routing, delegation, restart recovery)

**Suite B — Triggers + Notifications:** Read and execute `.claude/docs/e2e/suite-b-triggers-notifications.md`
(Trigger creation/enable/fire, cron execution, task results, audit logging, credential protection, notification routing isolation, trigger persistence, LLM-based notify decisions)

**Suite C — Stress & Recovery:** Read and execute `.claude/docs/e2e/suite-c-stress.md`
(5 concurrent connections, per-socket serialization, restart recovery, system stability)

**Suite D — Browser:** Read and execute `.claude/docs/e2e/suite-d-browser.md`
(MCP gating, allowed_tools, domain allowlist, navigation, screenshot, SSRF protection, cross-team isolation, idle TTL, lifecycle)

**Suite E — Conversation + Threading:** Read and execute `.claude/docs/e2e/suite-e-context-threading.md`
(Interaction logging, sub-team attribution, conversation context, follow-up routing, topic creation, classification, parallel topics, lifecycle)

**Suite F — Cascade Deletion:** Read and execute `.claude/docs/e2e/suite-f-cascade-deletion.md`
(Hierarchy creation main→A1→A11, data population, cascade shutdown, 6-table cleanup, filesystem removal)

**Suite G — Skill Repository:** Read and execute `.claude/docs/e2e/suite-g-skill-repo.md`
(search_skill_repository tool, skill search/adoption, format validation, graceful degradation)

**NOTE:** If smoke checks 21-22 (browser relay) failed, skip Suite D entirely.

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
  N/25 passed (22 original + 3 enhanced)
  Failures: [list with evidence]

Phase B: Investigative Suites
  Suite A (Teams + Hierarchy + Memory):  [summary + verification script results]
    - Memory write + persistence: [pass/fail]
    - Team creation + credentials: [pass/fail]
    - get_credential tool: [pass/fail]
    - Credential scrubbing (logs/DB/responses): [pass/fail]
    - Hierarchy (parent-child): [pass/fail]
    - Routing + delegation: [pass/fail]
    - Restart recovery (teams + memory): [pass/fail]
  Suite B (Triggers + Notifications):    [summary + verification script results]
    - Trigger setup + activation: [pass/fail]
    - Cron firing + task result: [pass/fail]
    - Audit logging (PreToolUse/PostToolUse): [pass/fail]
    - Credential protection: [pass/fail]
    - Notification routing isolation: [pass/fail]
    - Trigger persistence across restart: [pass/fail]
    - LLM-based notify decisions: [pass/fail]
  Suite C (Stress & Recovery):           [summary + verification script results]
    - Concurrent connections: [pass/fail]
    - Per-socket serialization: [pass/fail]
    - Restart recovery: [pass/fail]
  Suite D (Browser): Mark "skipped" if smoke checks 21-22 failed.
    - Gating (MCP, allowed_tools, domain allowlist): [pass/fail/skipped]
    - Operations (navigate, screenshot, SSRF): [pass/fail/skipped]
    - Isolation (cross-team, separate PIDs): [pass/fail/skipped]
    - Lifecycle (idle TTL, re-spawn, restart): [pass/fail/skipped]
  Suite E (Conversation + Threading):    [summary + verification script results]
    - Interaction logging (inbound/outbound): [pass/fail]
    - Conversation context in prompt: [pass/fail]
    - Topic creation + classification: [pass/fail]
    - Topic lifecycle + limits: [pass/fail]
  Suite F (Cascade Deletion):            [summary + verification script results]
    - Hierarchy created: [pass/fail]
    - Data populated: [pass/fail]
    - 6-table cascade cleanup: [pass/fail]
    - Filesystem dirs removed: [pass/fail]
    - Main still healthy: [pass/fail]
  Suite G (Skill Repository):            [summary + verification script results]
    - search_skill_repository tool: [pass/fail]
    - Skill format + trust signals: [pass/fail]
    - Graceful degradation: [pass/fail]

Critical Findings:
  [List any bugs found with root cause analysis]

Recommendations:
  [What should be fixed before production]
```
