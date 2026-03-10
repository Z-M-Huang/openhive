---
name: dispatch-task
description: Fire-and-forget task dispatch
---

Dispatch a task to an agent. Returns immediately with task ID and status.
Use dispatch_task_and_wait if you need to wait for the result.

## Parameters
- `agent_aid` (string, required) — Target agent AID
- `prompt` (string, required) — Task prompt/instructions

## Example
dispatch_task(agent_aid="aid-weatherbot-abc12345", prompt="Get weather for NYC")
→ { task_id: "550e8400-...", status: "running" }

## Notes
- The task runs asynchronously; use get_task_status to check progress
- Prefer dispatch_task_and_wait for most use cases
