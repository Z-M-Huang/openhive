---
name: create-agent
description: Create a new agent in a team
---

Create a new agent. Returns the agent's AID.

## Parameters
- `name` (string, required) — Display name, e.g. "WeatherBot"
- `description` (string, required, NON-EMPTY) — 1-2 sentence role summary
- `team_slug` (string, required) — Team slug or "master" for top-level agents
- `provider` (string, optional) — Provider preset name
- `model_tier` (string, optional) — "haiku" | "sonnet" | "opus"

## Example
create_agent(name="WeatherBot", description="Fetches weather data for any location", team_slug="master")
→ { aid: "aid-weatherbot-abc12345", status: "created" }

## Notes
- The description MUST be non-empty (validation will reject empty strings)
- Use team_slug="master" for agents that will lead top-level teams
- The AID returned is needed for create_team's leader_aid parameter
