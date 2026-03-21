/**
 * Helper functions for the agent executor.
 *
 * @module executor/executor-helpers
 */

import type { AgentInitConfig, TaskStore } from '../domain/interfaces.js';

/** Default query timeout: 5 minutes. */
export const DEFAULT_QUERY_TIMEOUT_MS = 300_000;

/**
 * Queries the last 10 user-originated completed tasks for this agent
 * and formats them as a "Recent Conversation History" section for the system prompt (Tier 3).
 * Filters by origin_chat_jid IS NOT NULL AND parent_id = '' to exclude subtasks and proactive tasks.
 */
export async function getRecentHistory(taskStore: TaskStore, agentAid: string): Promise<string | null> {
  const agentTasks = await taskStore.getRecentUserTasks(agentAid, 10);

  if (agentTasks.length === 0) return null;

  const lines = ['## Recent Conversation History'];
  for (const task of agentTasks.reverse()) {
    const promptSnippet = task.prompt.length > 500 ? task.prompt.slice(0, 500) + '...' : task.prompt;
    const resultSnippet = (task.result ?? '').length > 1000 ? task.result!.slice(0, 1000) + '...' : (task.result ?? '');
    lines.push(`User: ${promptSnippet}`);
    lines.push(`Assistant: ${resultSnippet}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Extracts team slug from agent config or defaults to 'main'.
 */
export function resolveTeamSlug(_agent: AgentInitConfig): string {
  // Agent's team slug is typically set in the init config
  // For root agents, use 'main' as the default
  return 'main';
}
