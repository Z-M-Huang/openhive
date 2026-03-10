---
name: consolidate-results
description: Retrieve results for multiple tasks by ID
---

Gather status and results for multiple tasks by their IDs. Returns each task's current status, result (if completed), and error (if failed). Tasks not found are returned with status `not_found`.

## Parameters
- `task_ids` (string[], required) — Array of task IDs to retrieve results for

## Returns
```json
{
  "tasks": [
    { "task_id": "...", "status": "completed", "result": "..." },
    { "task_id": "...", "status": "running" },
    { "task_id": "...", "status": "not_found" }
  ]
}
```

Possible `status` values: `pending`, `running`, `completed`, `failed`, `cancelled`, `not_found`

## Example
consolidate_results(task_ids=["550e8400-...", "661f9511-..."])
→ { tasks: [{ task_id: "550e8400-...", status: "completed", result: "..." }, { task_id: "661f9511-...", status: "running" }] }
