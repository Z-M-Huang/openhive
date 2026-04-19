/**
 * System prompt builder — assembles the full system prompt for AI SDK streamText().
 * Replaces the Claude Code preset approach with explicit prompt construction.
 */

import type { InteractionRecord } from '../domain/interfaces.js';
import type { RuleCascadeResult } from '../rules/cascade.js';

export interface PluginToolInfo {
  readonly name: string;
  readonly description: string;
}

export interface PromptBuilderOpts {
  readonly teamName: string;
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly ruleCascade: RuleCascadeResult;
  readonly skillsContent: string;
  readonly memorySection: string;
  readonly conversationHistory?: string;
  readonly topicName?: string;
  /**
   * Plugin tools loaded into this session (namespaced as `<team>.<tool>` plus
   * their description text). When non-empty, the tool-availability note lists
   * them under the ADR-39 plugin section and downgrades `web_fetch` from
   * "preferred" to "fall-back only" so the LLM doesn't default to raw HTTP.
   */
  readonly pluginTools?: readonly PluginToolInfo[];
}

/** Two-part system prompt for cache-friendly Anthropic requests. */
export interface SystemPromptParts {
  /** Cacheable across teams on same image + admin config: system rules, admin org-rules, tool guide, HTTP rules. */
  readonly staticPrefix: string;
  /** Per-team, per-request: core instructions (cwd), tool availability, credentials, ancestor/team rules, skills, memory, history. */
  readonly dynamicSuffix: string;
}

export function buildSystemPrompt(opts: PromptBuilderOpts): SystemPromptParts {
  // ── Static prefix (byte-identical across teams with same image + admin config) ──
  const staticSections: string[] = [];

  // 1. System rules (Tier 1) + Admin org-rules (Tier 2)
  if (opts.ruleCascade.staticRules) staticSections.push(opts.ruleCascade.staticRules);

  // 2. Tool usage guide
  staticSections.push(buildToolUsageGuide());

  // 3. HTTP request rules
  staticSections.push(buildHttpRules());

  const staticPrefix = staticSections.filter(Boolean).join('\n\n');

  // ── Dynamic suffix (per-team, per-request) ──────────────────────────────
  const dynamicSections: string[] = [];

  // 4. Core identity and instructions (includes workspace path — per-team)
  dynamicSections.push(buildCoreInstructions(opts.cwd));

  // 5. Tool availability note
  dynamicSections.push(buildToolAvailabilityNote(opts.allowedTools, opts.pluginTools));

  // AC-27: Credential key names are never injected into the prompt. Agents
  // discover keys via `vault_list` at point of use; values are only returned
  // by `vault_get`. Real secret values are scrubbed from output in
  // message-handler / task-consumer using vault + provider secrets.

  // 6. Ancestor/team org-rules (Tier 3) + Team-only rules (Tier 4)
  if (opts.ruleCascade.dynamicRules) dynamicSections.push(opts.ruleCascade.dynamicRules);

  // 7. Skills content
  if (opts.skillsContent) dynamicSections.push(opts.skillsContent);

  // 8. Memory (injectable entries from SQLite)
  if (opts.memorySection) dynamicSections.push(opts.memorySection);

  // 9. Topic context
  if (opts.topicName) {
    dynamicSections.push(`## Current Topic\nYou are responding within the topic "${opts.topicName}". Stay focused on this topic.`);
  }

  // 10. Recent channel conversation history
  if (opts.conversationHistory) dynamicSections.push(opts.conversationHistory);

  const dynamicSuffix = dynamicSections.filter(Boolean).join('\n\n');

  return { staticPrefix, dynamicSuffix };
}

// ── Section builders ─────────────────────────────────────────────────────────

export function buildCoreInstructions(cwd: string): string {
  return `You are an AI agent team member in the OpenHive system. You operate within a team hierarchy managed by the organization orchestrator. Follow your team's rules and use the tools available to you to complete tasks.

## Workspace
Your working directory is \`${cwd}\`. All file paths for Read, Write, Edit, Glob, and Grep tools MUST use paths relative to or under this directory.

## Memory
Your memory is managed via the memory_save, memory_search, memory_list, and memory_delete tools. Do NOT read or write memory files directly.`;
}

/**
 * Build a dynamic tool availability note for the system prompt.
 * Tells the agent which tools are actually enabled for this team,
 * preventing the LLM from incorrectly believing tools like Bash are denied.
 *
 * Build a note about tool availability for the system prompt.
 */
export function buildToolAvailabilityNote(
  allowedTools: readonly string[],
  pluginTools: readonly PluginToolInfo[] = [],
): string {
  const allowAll = allowedTools.includes('*');
  const lines: string[] = ['--- Tool Availability for This Team ---'];

  if (allowAll) {
    lines.push('All tools are ENABLED for this team.');
    const builtins = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;
    for (const tool of builtins) {
      lines.push(`- **${tool}** — ENABLED`);
    }
  } else {
    const builtins = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;
    for (const tool of builtins) {
      const enabled = allowedTools.includes(tool) ||
        allowedTools.some(e => e.endsWith('*') && tool.startsWith(e.slice(0, -1)));
      lines.push(`- **${tool}** — ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }
  }

  // web_fetch guidance when available — wording flips when plugins exist so
  // the LLM doesn't default to raw HTTP over a registered plugin tool.
  const hasWebFetch = allowedTools.includes('web_fetch') ||
    allowedTools.some(e => e.endsWith('*'));
  if (hasWebFetch) {
    if (pluginTools.length > 0) {
      lines.push('- **web_fetch** — ENABLED (fall-back only — prefer the plugin tools listed below)');
    } else {
      lines.push('- **web_fetch** — ENABLED (preferred for HTTP requests)');
    }
  }

  // Plugin section
  lines.push('');
  lines.push('## Plugin Tools (Plugin-First Invariant — ADR-39)');
  if (pluginTools.length > 0) {
    lines.push('The following plugin tools are registered. PREFER these over Bash/curl/web_fetch for their documented domain:');
    for (const plugin of pluginTools) {
      lines.push(`- **${plugin.name}** — ${plugin.description}`);
    }
  } else {
    lines.push('No plugin tools are loaded in this session. For external operations, delegate to a subagent whose skill declares the required plugin in \'## Required Tools\'.');
  }

  // Bash guidance
  lines.push('');
  lines.push('## When to use Bash');
  lines.push('Bash is for local shell commands within your workspace only. For external APIs or HTTP requests, use web_fetch or a plugin tool.');

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

export function buildHttpRules(): string {
  return `## HTTP Request Rules
- Prefer a registered plugin tool (or web_fetch) for HTTP work when one exists. Use Bash/curl only for local shell work or when no plugin/web_fetch path applies.
- ALWAYS use timeouts on HTTP requests. If you must fall back to a shell client, set an explicit timeout (e.g. curl \`--connect-timeout 10 --max-time 60\`, wget \`--timeout=60\`, Python \`timeout=60\`).
- If a request fails due to authentication, do NOT retry more than twice. Report the error clearly.
- Never retry indefinitely — 2 attempts max for auth failures, 3 for transient errors.`;
}

export function buildConversationHistorySection(interactions: InteractionRecord[]): string {
  if (interactions.length === 0) return '';

  const lines = [
    '## Recent Channel Conversation',
    'Below are the most recent messages on this channel. Use this context to understand follow-up questions and route them to the team that originally handled the topic.',
    '',
  ];

  for (const msg of interactions) {
    const time = msg.createdAt ?? 'unknown';
    if (msg.direction === 'inbound') {
      lines.push(`[${time}] User (${msg.userId ?? 'unknown'}): ${msg.contentSnippet ?? ''}`);
    } else {
      lines.push(`[${time}] [${msg.teamId ?? 'system'}] → ${msg.contentSnippet ?? ''}`);
    }
  }

  return lines.join('\n');
}
