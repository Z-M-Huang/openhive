---
name: delete-team
description: Delete a team by slug
---

Delete a team and its configuration. Cascades to workspace removal and
marks in-progress tasks as failed.

## Parameters
- `slug` (string, required) — Team slug to delete

## Example
delete_team(slug="weather")
→ { status: "deleted", slug: "weather" }

## Notes
- Fails if any agent in the team leads a sub-team (delete sub-teams first)
- All pending/running tasks for the team are marked as failed
- The workspace directory is removed
