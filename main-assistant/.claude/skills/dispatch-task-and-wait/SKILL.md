---
name: dispatch-task-and-wait
description: Dispatch and block until result (preferred)
---

Dispatch a task to an agent and wait for the result. This is the preferred
method for task dispatch as it blocks until completion or timeout.

## Parameters
- `agent_aid` (string, required) — Target agent AID
- `prompt` (string, required) — Task prompt/instructions
- `timeout_seconds` (number, optional, default 300) — Max wait time in seconds

## Example
dispatch_task_and_wait(agent_aid="aid-weatherbot-abc12345", prompt="Get weather for NYC")
→ { task_id: "550e8400-...", status: "completed", result: "NYC: 45°F, partly cloudy" }

## Notes
- Blocks until the task completes, fails, is cancelled, or times out
- Default timeout is 300 seconds (5 minutes)
- Returns the full task result inline — no polling needed
- If the task times out, returns status: "timeout"
