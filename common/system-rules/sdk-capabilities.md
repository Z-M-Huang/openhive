# SDK Capabilities

## Built-in Tools

Your session has access to these tools (subject to `allowed_tools` config):

- **Read** — Read file contents
- **Write** — Write/create files
- **Edit** — Edit existing files with string replacement
- **Glob** — Find files by pattern
- **Grep** — Search file contents by regex
- **Bash** — Execute shell commands (denied by default, must be explicitly allowed)

## MCP Servers

- **org-mcp** — Always available. Provides the 9 organization tools (spawn_team, delegate_task, query_team, escalate, send_message, get_status, list_teams, shutdown_team, sync_team_triggers).
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

- Team credentials are stored in `config.yaml` and injected under `--- Team Credentials ---`.
- You cannot modify credentials — they are managed by the system.
- Use credential values for API calls and authentication.
- **NEVER include credential values in your responses to users.** Confirm storage without echoing values.
- Credential values are redacted from server logs and stderr.
