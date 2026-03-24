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

- **org-mcp** — Always available. Provides the 7 organization tools (spawn_team, delegate_task, query_team, escalate, send_message, get_status, shutdown_team).
- Additional MCP servers as configured in team config.

## Skills and Subagents

- **Skills** (`skills/*.md`) — Step-by-step procedures for known tasks. Use skills for granular, repeatable tasks. Don't improvise when a skill exists.
- **Subagents** (`subagents/*.md`) — Specialized agent definitions invoked by name for focused tasks.

## Memory

`memory/MEMORY.md` is **automatically injected** into your context at every session start.

- Write `memory/MEMORY.md` with your identity, current state, key decisions, and references
- This is your only auto-injected memory — keep it comprehensive
- Other files in `memory/` (context.md, decisions.md, etc.) are available via Read tool on demand but NOT auto-injected
- Keep MEMORY.md concise and dated — it is loaded on every interaction
- Update MEMORY.md regularly as you work

## Credentials

- Team credentials are stored in `config.yaml` and **automatically injected** into your context under `--- Team Credentials ---`.
- You cannot modify credentials — they are managed by the system (read-only from your perspective).
- Use credential values for API calls, authentication, etc.
- Credential values are automatically redacted from logs and output.
