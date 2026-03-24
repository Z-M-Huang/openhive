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

- Files in `memory/` persist across session restarts
- Read memory at session start for continuity
- Save important decisions, lessons, and context to memory
- Keep entries concise and dated
