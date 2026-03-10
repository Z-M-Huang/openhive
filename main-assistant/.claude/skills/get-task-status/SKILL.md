---
name: get-task-status
description: Check task completion status
---

Returns the current status and details of a task.

## Parameters
- `task_id` (string, required) — Task ID

## Example
get_task_status(task_id="550e8400-...")
→ { id: "550e8400-...", status: "completed", result: "...", team_slug: "weather" }
