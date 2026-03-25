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

**IMPORTANT:** Do NOT use Claude Code's built-in auto-memory system (`~/.claude/projects/*/memory/`). OpenHive has its own memory system.

Your team memory directory is in `additionalDirectories` as `../memory/` (relative to your workspace CWD). The absolute path is `{your_team_dir}/memory/MEMORY.md`.

`MEMORY.md` in your team's memory directory is **automatically injected** into your context at every session start.

- Write `../memory/MEMORY.md` (from your CWD) with your identity, current state, key decisions, and references
- This is your only auto-injected memory — keep it comprehensive
- Other files in `../memory/` are available via Read tool on demand but NOT auto-injected
- Keep MEMORY.md concise and dated — it is loaded on every interaction
- Update MEMORY.md regularly as you work
- When asked to remember something, write it to `../memory/MEMORY.md` — NOT to Claude's internal memory

## Credentials

- Team credentials are stored in `config.yaml` and **automatically injected** into your context under `--- Team Credentials ---`.
- You cannot modify credentials — they are managed by the system (read-only from your perspective).
- Use credential values for API calls, authentication, etc.
- Credential values are automatically redacted from logs and output.
