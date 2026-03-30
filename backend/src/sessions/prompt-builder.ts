/**
 * System prompt builder — assembles the full system prompt for AI SDK streamText().
 * Replaces the Claude Code preset approach with explicit prompt construction.
 */

export interface PromptBuilderOpts {
  readonly teamName: string;
  readonly allowedTools: readonly string[];
  readonly credentialKeys: readonly string[];
  readonly ruleCascade: string;
  readonly skillsContent: string;
  readonly memorySection: string;
}

export function buildSystemPrompt(opts: PromptBuilderOpts): string {
  const sections: string[] = [];

  // 1. Core identity and instructions
  sections.push(buildCoreInstructions());

  // 2. Tool availability note
  sections.push(buildToolAvailabilityNote(opts.allowedTools));

  // 3. Tool usage guide (NEW — was provided by Claude Code preset)
  sections.push(buildToolUsageGuide());

  // 4. Credential availability note
  if (opts.credentialKeys.length > 0) {
    sections.push(buildCredentialNote(opts.credentialKeys));
  }

  // 5. HTTP request rules
  sections.push(buildHttpRules());

  // 6. Rule cascade (system + admin + ancestor + team rules)
  if (opts.ruleCascade) sections.push(opts.ruleCascade);

  // 7. Skills content
  if (opts.skillsContent) sections.push(opts.skillsContent);

  // 8. Memory (MEMORY.md content)
  if (opts.memorySection) sections.push(opts.memorySection);

  return sections.filter(Boolean).join('\n\n');
}

// ── Section builders ─────────────────────────────────────────────────────────

export function buildCoreInstructions(): string {
  return `You are an AI agent team member in the OpenHive system. You operate within a team hierarchy managed by an Organization MCP Server. Follow your team's rules and use the tools available to you to complete tasks.`;
}

/**
 * Build a dynamic tool availability note for the system prompt.
 * Tells the agent which tools are actually enabled for this team,
 * preventing the LLM from incorrectly believing tools like Bash are denied.
 *
 * Ported from query-options.ts buildToolAvailabilityNote().
 */
export function buildToolAvailabilityNote(allowedTools: readonly string[]): string {
  const allowAll = allowedTools.includes('*');
  const lines: string[] = ['--- Tool Availability for This Team ---'];
  if (allowAll) {
    lines.push('All tools are ENABLED for this team. You HAVE Bash and MUST use it when you need to run shell commands, make HTTP requests (curl), or execute scripts (python3, node).');
  } else {
    const builtins = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;
    for (const tool of builtins) {
      const enabled = allowedTools.includes(tool) ||
        allowedTools.some(e => e.endsWith('*') && tool.startsWith(e.slice(0, -1)));
      lines.push(`- **${tool}** — ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }
  }
  lines.push('Use Bash for HTTP requests (curl), script execution, and system commands when enabled.');
  return lines.join('\n');
}

export function buildToolUsageGuide(): string {
  return `## Available Built-in Tools

- **Read** — Read a file. Parameters: file_path (string), offset? (number), limit? (number)
- **Write** — Write content to a file. Parameters: file_path (string), content (string)
- **Edit** — Replace text in a file. Parameters: file_path (string), old_string (string), new_string (string), replace_all? (boolean)
- **Glob** — Find files matching a pattern. Parameters: pattern (string), path? (string)
- **Grep** — Search file contents. Parameters: pattern (string), path? (string), type? (string), glob? (string)
- **Bash** — Execute a shell command. Parameters: command (string), timeout? (number)

Use these tools to read, modify, and explore the filesystem within your workspace.`;
}

export function buildCredentialNote(keys: readonly string[]): string {
  return `\n## Available Credentials\nThis team has credentials configured: ${keys.map(k => `\`${k}\``).join(', ')}. Use \`get_credential({ key: "KEY_NAME" })\` to retrieve each value at point of use. Never hardcode or store credential values.\n`;
}

export function buildHttpRules(): string {
  return `## HTTP Request Rules
- ALWAYS use timeouts on HTTP requests. For curl: \`--connect-timeout 10 --max-time 60\`.
- For wget: \`--timeout=60\`. For Python requests: \`timeout=60\`.
- If a request fails due to authentication, do NOT retry more than twice. Report the error clearly.
- Never retry indefinitely — 2 attempts max for auth failures, 3 for transient errors.`;
}
