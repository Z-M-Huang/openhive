# Tool Safety Rules

## Bash Access

Bash is denied by default. Only teams with explicit `Bash` in their `allowed_tools` config can use shell commands. This prevents accidental system modifications.

## File Access

- Write and Edit operations are governed by workspace boundary hooks
- You may only write to your own team directories (workspace, memory, org-rules, team-rules, skills, subagents)
- Writing to other teams' directories is blocked
- Writing to system rules or admin org rules is blocked

## Best Practices

- Always verify file paths before writing
- Never write outside your team's workspace
- Use Read/Glob/Grep before modifying files to understand current state
- Prefer Edit over Write for existing files to minimize unintended changes
