# SDK Capabilities

## Built-in Tools

Your session has access to these tools (subject to `allowed_tools` config):

- **Read** — Read file contents
- **Write** — Write/create files
- **Edit** — Edit existing files with string replacement
- **Glob** — Find files by pattern
- **Grep** — Search file contents by regex
- **Bash** — Execute shell commands (curl, python3, node, etc.). Check the "Tool Availability" section below for your team's actual permissions.

## Built-in Tools

- **Organization tools** — Always available: spawn_team, delegate_task, query_team, escalate, send_message, get_status, list_teams, shutdown_team, vault_get, vault_set, vault_list, vault_delete, create_trigger, enable_trigger, disable_trigger, test_trigger, list_triggers, update_team, update_trigger. Teams with `browser:` config also get browser tools (browser_navigate, browser_snapshot, browser_screenshot, browser_click, browser_type, browser_go_back, browser_go_forward, browser_close).
- **web_fetch** — HTTP fetch with SSRF protection.
- Additional plugin tools as registered in team config (see `plugins/*.ts`).

## Skills, Plugin Tools, and Subagents

- **Skills** (`skills/*.md`) — Step-by-step procedures for known tasks. Use skills for granular, repeatable tasks. Don't improvise when a skill exists.
- **Plugin tools** (`plugins/*.ts`) — Team-local TypeScript tool definitions for custom automation (API calls, data parsing). Use `register_plugin_tool` to create. Plugins provide executable logic; skills orchestrate.
- **Subagents** (`subagents/*.md`) — Specialized agent definitions invoked by name for focused tasks.

## Memory

**IMPORTANT:** Do NOT use Claude Code's built-in auto-memory system (`~/.claude/projects/*/memory/`). OpenHive has its own memory system.

Active memories are **auto-injected** into every session — this is your ONLY continuity between messages.

### Memory Tools

- **`memory_save`** — Store a typed memory entry. Types: `identity`, `lesson`, `decision`, `context`, `reference`, `historical`. When updating an existing key, you MUST provide `supersede_reason` explaining why the old value is being replaced.
- **`memory_search`** — Search memories by keyword (always available) or hybrid keyword+vector (when an embedding provider is configured).
- **`memory_list`** — List active memories, optionally filtered by type.
- **`memory_delete`** — Soft-delete a memory entry by key.

### When to Save Memory

After handling a request, save a memory if ANY of these apply:
- User shared their name, role, preferences, or project context
- You created, modified, or shut down a team
- User asked you to remember something
- A decision was made that affects future interactions

## Credentials (Team Vault)

- Call `vault_get({ key: "KEY_NAME" })` to retrieve a credential value on demand.
- Use `vault_set({ key, value, is_secret? })` to store a new credential.
- Use `vault_list()` to see available keys and metadata.
- Use `vault_delete({ key })` to remove a credential.
- NEVER store credential values in memory (via memory_save), skills/, or team-rules/ files.
- NEVER include credential values in task results or responses.
- Use credentials only at the point of use (API calls, HTTP headers).
- The system automatically scrubs credential values from file writes.
- Credential values are redacted from server logs and stderr.

## Response Style

When producing task results or responding to delegated work:
- Focus on **what you accomplished**, not implementation details
- Do NOT reference internal paths (`skills/`, `config.yaml`,
  `org-rules/`, `team-rules/`, `subagents/`, `.run/teams/`)
- Describe outcomes: "Set up email triage with 3 label categories" — NOT
  "Created skills/triage.md and saved 3 memories"
- Numbered bootstrap steps, file operations, and directory listings are internal —
  never include them in results

Internal communication (via `escalate` or `send_message` to other teams) may
reference implementation details for technical coordination.
