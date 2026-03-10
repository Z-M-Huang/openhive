---
name: cancel-task
description: Cancel a running task
---

Cancel a pending or running task. Sends a shutdown signal to the container.

## Parameters
- `task_id` (string, required) — Task ID to cancel

## Example
cancel_task(task_id="550e8400-...")
→ { task_id: "550e8400-...", status: "cancelled" }

## Notes
- Cannot cancel tasks that are already completed, failed, or cancelled
