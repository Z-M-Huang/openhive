---
name: system-smoke
description: "Live-system diagnostic that runs a structured pass/fail checklist to verify core infrastructure health"
disable-model-invocation: true
user-invocable: true
allowed-tools:
  - get_health
  - inspect_topology
  - get_task
  - send_message
---

## When to Apply

Use this skill when you need to verify that the core OpenHive infrastructure is functioning correctly. This is a diagnostic skill -- it runs a structured checklist and returns a pass/fail report for each subsystem.

Typical triggers:
- After a system restart or deployment.
- When multiple agents report failures simultaneously.
- When a supervisor requests a system integrity check.
- As part of a periodic (e.g., daily) proactive maintenance check.
- When invoked via the `/system-smoke` user command.

This skill is **not auto-triggered** (`disable-model-invocation: true`). It runs only when explicitly requested to avoid unnecessary overhead.

## Smoke Test Checklist

The smoke test verifies four core subsystems. Each check produces a `pass` or `fail` result with optional detail.

### Check 1: WebSocket Connectivity (ws_ok)

**Purpose:** Verify the WebSocket hub is operational and this container can communicate with the root.

**How to verify:**
- The fact that you are executing this skill means your container has an active WebSocket connection to the hub (tool calls are routed via WebSocket).
- Use `get_health` with your own AID. If the call succeeds, the WebSocket round-trip is functional.
- If `get_health` times out or returns an error, the WebSocket connection is degraded.

**Pass criteria:** `get_health` returns a valid response within 10 seconds.

### Check 2: Heartbeat System (heartbeat_ok)

**Purpose:** Verify the heartbeat mechanism is functioning -- containers are reporting liveness and the root is tracking them.

**How to verify:**
- Use `get_health` scoped to your team (or system-wide if you are the main assistant).
- Check the `heartbeat_age` for each agent. All active agents should have heartbeat ages under 60 seconds.
- If any agent shows a heartbeat age over 300 seconds, the heartbeat system may be degraded.

**Pass criteria:** All agents in scope have heartbeat ages under 300 seconds. Warning if any are between 60-300 seconds.

### Check 3: Task Round-Trip (task_roundtrip_ok)

**Purpose:** Verify the task creation, dispatch, and status update pipeline is functional end-to-end.

**How to verify:**
- Use `get_task` to query a recent task (any status). If the query succeeds, the task system's read path is functional.
- Check the response for valid task structure (id, status, timestamps).
- If no tasks exist yet (fresh system), this check passes with a note: "No tasks in system -- read path verified, write path untested."

**Pass criteria:** `get_task` returns a valid response. Task structure contains expected fields.

### Check 4: Portal Event Delivery (portal_event_ok)

**Purpose:** Verify that the WebSocket event stream to the web portal is operational.

**How to verify:**
- Use `inspect_topology` to confirm the root container is running and the topology is queryable. The portal receives its data through the same event infrastructure.
- If `inspect_topology` returns a valid topology tree, the event delivery pipeline from root to consumers is functioning.
- If `inspect_topology` fails or returns an empty tree, portal event delivery may be impaired.

**Pass criteria:** `inspect_topology` returns a non-empty topology tree with at least the root team.

## Output Format

After running all checks, compile the results into a structured report:

```
## System Smoke Test Report
Timestamp: [ISO 8601]
Executed by: [agent AID]
Overall: [PASS | FAIL | DEGRADED]

### Results

| Check              | Status | Detail                          |
|--------------------|--------|---------------------------------|
| ws_ok              | PASS   | get_health round-trip: 45ms     |
| heartbeat_ok       | PASS   | 4/4 agents within threshold     |
| task_roundtrip_ok  | PASS   | Task task-abc-123 retrieved OK  |
| portal_event_ok    | PASS   | Topology: 3 teams, 8 agents    |

### Summary
All 4 checks passed. System is operational.
```

Overall status rules:
- **PASS:** All 4 checks pass.
- **DEGRADED:** 1-2 checks fail, or any check passes with warnings.
- **FAIL:** 3+ checks fail, or `ws_ok` fails (foundational connectivity broken).

## Responding to /system-smoke Command

When invoked via the `/system-smoke` user command:

1. Run all 4 checks in sequence.
2. Present the structured report table directly in your response.
3. If any checks fail, include specific remediation suggestions.
4. If `$ARGUMENTS` contains `verbose`, include raw response data from each tool call.

## Failure Remediation

| Failed Check | Likely Cause | Suggested Action |
|-------------|-------------|-----------------|
| ws_ok | WebSocket hub down or connection dropped | Check root container status; container may need restart |
| heartbeat_ok | Agent or container crashed | Identify stale agents; check container logs for crashes |
| task_roundtrip_ok | Database unavailable or write queue stalled | Check SQLite database at `/app/workspace/openhive.db`; verify disk space |
| portal_event_ok | Event broadcast service down | Check root orchestrator logs for event emission errors |

When multiple checks fail, address them in order: ws_ok first (foundational), then heartbeat_ok, then task_roundtrip_ok, then portal_event_ok. Downstream checks depend on upstream connectivity.
