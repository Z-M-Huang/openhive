# OpenHive Rules & Team Configuration Examples

This directory contains examples of the files that live under `.run/teams/{name}/` at runtime.

## Directory Structure (per team)

```
.run/teams/{name}/
  config.yaml       # Team manifest (see data/config/config.yaml.example)
  org-rules/        # Rules that cascade to ALL child teams
  team-rules/       # Rules for THIS team only (like CLAUDE.md)
  skills/           # Step-by-step procedures (reusable across agents)
  subagents/        # Specialized agent definitions
  workspace/        # Agent working directory (cwd)
  memory/           # Persistent notes across sessions
```

## How to Use

1. Copy examples to `.run/teams/main/` after first boot to customize the main team
2. Or create new teams via the `spawn_team` MCP tool — the AI handles scaffolding

## Rule Cascade Order

1. `/app/system-rules/*.md` — Baked into Docker image (immutable)
2. `/data/rules/*.md` — Admin org rules (this directory, shared across all teams)
3. `.run/teams/{ancestor}/org-rules/*.md` — Ancestor org-rules (cascade down)
4. `.run/teams/{name}/team-rules/*.md` — Team-specific rules (no cascade)

Later rules take precedence. System rules cannot be overridden.
