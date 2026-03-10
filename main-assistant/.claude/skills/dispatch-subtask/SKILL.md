---
name: dispatch-subtask
description: Dispatch a subtask under a parent task
---

Dispatch a subtask linked to a parent task. Used for breaking complex
tasks into parallel sub-operations.

## Parameters
- `agent_aid` (string, required) — Target agent AID
- `prompt` (string, required) — Subtask prompt
- `parent_task_id` (string, optional) — Parent task ID to link to

## Example
dispatch_subtask(agent_aid="aid-checker-abc", prompt="Check weather", parent_task_id="550e8400-...")
→ { task_id: "661f9511-...", status: "running" }
