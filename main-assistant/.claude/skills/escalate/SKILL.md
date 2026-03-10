---
name: escalate
description: Escalate a task to parent
---

Escalate a task to a supervisor when the current agent cannot complete it.

## Parameters
- `task_id` (string, required) — Task ID to escalate
- `reason` (string, required) — Reason for escalation
- `context` (string, optional) — Additional context for the supervisor

## Example
escalate(task_id="550e8400-...", reason="Requires API access I don't have")
→ { task_id: "...", status: "escalated" }
