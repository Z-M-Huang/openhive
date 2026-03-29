# SDK Capabilities

## Built-in Tools

Your session has access to these tools (subject to `allowed_tools` config):

- **Read** — Read file contents
- **Write** — Write/create files
- **Edit** — Edit existing files with string replacement
- **Glob** — Find files by pattern
- **Grep** — Search file contents by regex
- **Bash** — Execute shell commands (curl, python3, node, etc.). Check the "Tool Availability" section below for your team's actual permissions.

## MCP Servers

- **org-mcp** — Always available. Provides organization tools (spawn_team, delegate_task, query_team, escalate, send_message, get_status, list_teams, shutdown_team, get_credential, create_trigger, enable_trigger, disable_trigger, test_trigger, list_triggers, update_team, update_trigger).
- Additional MCP servers as configured in team config.

## Skills and Subagents

- **Skills** (`skills/*.md`) — Step-by-step procedures for known tasks. Use skills for granular, repeatable tasks. Don't improvise when a skill exists.
- **Subagents** (`subagents/*.md`) — Specialized agent definitions invoked by name for focused tasks.

## Memory

**IMPORTANT:** Do NOT use Claude Code's built-in auto-memory system (`~/.claude/projects/*/memory/`). OpenHive has its own memory system.

Your team memory is at `memory/MEMORY.md` (relative to CWD). It is **auto-injected** into every session — this is your ONLY continuity between messages.

### Memory Protocol

1. **Before writing**: Read the current `memory/MEMORY.md` first (if it exists)
2. **Merge**: Combine existing content with new information — never blind-overwrite
3. **Write**: Save the merged result back to `memory/MEMORY.md`

### When to Update Memory

After handling a request, update MEMORY.md if ANY of these apply:
- User shared their name, role, preferences, or project context
- You created, modified, or shut down a team
- User asked you to remember something
- A decision was made that affects future interactions

### MEMORY.md Structure

Keep it concise and dated:
```
# User Context
- Name: ...
- Preferences: ...

# Active Teams
- team-name: purpose (created YYYY-MM-DD)

# Key Decisions
- ...
```

- Other files in `memory/` are available via Read but NOT auto-injected
- When asked to remember something, write to `memory/MEMORY.md` — NOT to Claude's internal memory

## Credentials

- Call `get_credential({ key: "KEY_NAME" })` to retrieve a credential value on demand.
- NEVER store credential values in skills/, memory/, or team-rules/ files.
- NEVER include credential values in task results or responses.
- Use credentials only at the point of use (API calls, HTTP headers).
- The system automatically scrubs credential values from file writes.
- Credential values are redacted from server logs and stderr.

## Response Style

When producing task results or responding to delegated work:
- Focus on **what you accomplished**, not implementation details
- Do NOT reference internal paths (`memory/`, `skills/`, `config.yaml`, `.bootstrapped`,
  `init-context.md`, `org-rules/`, `team-rules/`, `subagents/`, `.run/teams/`)
- Describe outcomes: "Set up email triage with 3 label categories" — NOT
  "Created skills/triage.md and wrote MEMORY.md"
- Numbered bootstrap steps, file operations, and directory listings are internal —
  never include them in results

Internal communication (via `escalate` or `send_message` to other teams) may
reference implementation details for technical coordination.
