---
name: list-tasks
description: List tasks (optionally by team)
---

List tasks filtered by team slug or status.

## Parameters
- `team_slug` (string, optional) — Filter by team slug
- `status` (string, optional) — Filter by status: pending, running, completed, failed, cancelled
- `limit` (number, optional) — Maximum results to return

## Example
list_tasks(team_slug="weather")
→ [{ id: "...", status: "running", prompt: "..." }, ...]

## Notes
- If neither team_slug nor status is provided, defaults to listing running tasks
