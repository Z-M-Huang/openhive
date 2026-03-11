---
name: health-report
description: "How to report health status and respond to health checks from the control plane"
user-invocable: true
allowed-tools:
  - get_health
  - inspect_topology
  - send_message
---

## When to Apply

Use this skill in two situations:

1. **Responding to health checks.** When the control plane dispatches a `proactive_check` task requesting a health report, or when a supervisor asks for your status.
2. **Proactive health monitoring.** When you are a team lead and need to assess the health of your team members and child teams during idle time.

## Steps

### 1. Gather Health Data

Use `get_health` to collect health metrics for the relevant scope:

- **Self-check:** Call `get_health` with your own AID to get your personal health status.
- **Team check (leads only):** Call `get_health` with your team slug to get health for all agents in your team.
- **System-wide (main assistant only):** Call `get_health` without a scope filter for the full system view.

Health data includes:
- **Heartbeat recency:** Time since last heartbeat from each agent/container.
- **Task load:** Number of active, pending, and completed tasks per agent.
- **Memory usage:** Container memory consumption.
- **Error rates:** Recent error counts from SDK hooks.

### 2. Gather Topology (Optional)

For team leads generating comprehensive reports, use `inspect_topology` to get the organizational structure:

- Team hierarchy and parent-child relationships.
- Agent-to-container mappings.
- Container status (running, stopped, error).

### 3. Assess Health Status

Evaluate the collected data against these thresholds:

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| Heartbeat age | < 60s | 60-300s | > 300s |
| Task queue depth | < 10 pending | 10-25 pending | > 25 pending |
| Error rate (last hour) | < 5 errors | 5-20 errors | > 20 errors |
| Memory usage | < 70% | 70-90% | > 90% |

Overall status is determined by the worst individual metric:
- **healthy**: All metrics within healthy range.
- **degraded**: One or more metrics in warning range, none critical.
- **unhealthy**: One or more metrics in critical range.

### 4. Compose the Report

Structure the health report clearly:

```
## Health Report - [Team/Agent Name]
Generated: [timestamp]
Overall Status: [healthy | degraded | unhealthy]

### Agent Status
| Agent | Heartbeat | Tasks (active/pending) | Errors (1h) | Status |
|-------|-----------|------------------------|-------------|--------|
| ...   | ...       | ...                    | ...         | ...    |

### Issues Detected
- [List any warning or critical conditions with specifics]

### Recommendations
- [Actionable suggestions for any issues found]
```

### 5. Report Results

- If responding to a health check task, report via `update_task_status` (see task-completion skill).
- If reporting proactively or to a supervisor, use `send_message` to deliver the report to the requesting agent.
- If critical issues are detected, escalate immediately (see escalation skill).

## Responding to /health-report Command

When invoked via the `/health-report` user command:

1. Parse `$ARGUMENTS` for optional modifiers:
   - `verbose` -- include per-agent detail and topology.
   - `<team-slug>` -- scope to a specific team.
   - No arguments -- report on your own team.

2. Generate the report following steps 1-4 above.

3. Present the report directly in your response. Use the table format for clarity.

## Health Check Frequency

Health checks are dispatched by the control plane based on each agent's `proactive_interval_minutes` setting. Default cadence:

- Team leads: Every 30 minutes.
- Main assistant: Every 15 minutes.
- Members: On-demand only (members do not run proactive health checks).

## Escalation Triggers

Automatically escalate (do not wait for the next scheduled check) when:

- Any agent has not sent a heartbeat in over 5 minutes (container may be down).
- Task queue depth exceeds 25 for any single agent (overloaded).
- Error rate exceeds 20 per hour for any agent (systemic failure).
- A container is in error state per topology inspection.
