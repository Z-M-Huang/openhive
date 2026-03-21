/**
 * System prompt enrichment and personal fact extraction for the agent executor.
 *
 * @module executor/executor-prompt
 */

// ---------------------------------------------------------------------------
// Personal info extraction (deterministic, no LLM needed)
// ---------------------------------------------------------------------------

/**
 * Extract personal facts from a user message for curated auto-save.
 * Returns a summary string if personal info is detected, null otherwise.
 * Uses lightweight regex patterns -- not exhaustive but catches common patterns.
 */
export function extractPersonalFacts(text: string): string | null {
  const facts: string[] = [];
  const lower = text.toLowerCase();

  // Name patterns: "I'm X", "my name is X", "I am X"
  const nameMatch = text.match(/(?:I'm|I am|my name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) facts.push(`Name: ${nameMatch[1]}`);

  // Location: "in City, ST", "in City ST", "I live in X", "based in X"
  const locMatch = text.match(/(?:I (?:live|am|'m) in|located in|based in|in)\s+([A-Z][a-zA-Z\s]+,\s*[A-Z]{2})\b/);
  if (locMatch) facts.push(`Location: ${locMatch[1].trim()}`);

  // Company/org: "at X Inc/Corp/LLC/Co", "my company is X", "I work at X", "I run X", "called X"
  const compMatch = text.match(/(?:at|my company is|I (?:work|am) at|I run|called)\s+([A-Z][A-Za-z\s]+(?:Inc|Corp|LLC|Co|Ltd|Systems|Tech|Pro|Labs|Studio|Group)?)\b/);
  if (compMatch) facts.push(`Work: ${compMatch[1].trim()}`);

  // Role: "I'm a X at", "I am a X", "my role is X", "I'm the X"
  const roleMatch = text.match(/(?:I'm a|I am a|my role is|I'm the)\s+([a-z][^.!?]{2,40?})(?:\s+at\b|[.,])/i);
  if (roleMatch) facts.push(`Role: ${roleMatch[1].trim()}`);

  // API/URL: explicit URLs or tokens shared
  if (lower.includes('url') || lower.includes('token') || lower.includes('api key') || lower.includes('endpoint')) {
    const urlMatch = text.match(/https?:\/\/[^\s,]+/);
    if (urlMatch) facts.push(`URL: ${urlMatch[0]}`);
  }

  // Entity IDs: HomeAssistant, IoT, etc.
  const entityMatch = text.match(/(?:entity|entity_id|script)\.\w[\w.]+/i);
  if (entityMatch) facts.push(`Entity: ${entityMatch[0]}`);

  if (facts.length === 0) return null;
  return facts.join('. ') + '.';
}

// ---------------------------------------------------------------------------
// Behavioral instructions constant (tool catalog + memory guidelines)
// ---------------------------------------------------------------------------

/**
 * Behavioral instructions appended to every agent's system prompt.
 * Contains tool catalog, memory management rules, and agent-per-task pattern.
 */
export const BEHAVIORAL_INSTRUCTIONS = `
## Your MCP Tools (MUST USE for system operations)

| Task | Tool to Use | Do NOT |
|------|-------------|--------|
| Remember facts | save_memory | Write to MEMORY.md directly |
| Search memories | recall_memory | Read MEMORY.md directly |
| Create an agent | create_agent | Write .claude/agents/*.md directly |
| Schedule recurring task | register_trigger | Suggest crontab or write YAML |
| Create a task | create_task | Describe tasks without creating them |
| Make HTTP calls | Bash with curl or /app/common/scripts/http-client.ts | Say you cannot make HTTP calls |

CRITICAL: Writing files directly does NOT register agents, triggers, or memories in the system. Only MCP tool calls update the database and org chart.

## Memory Management (MANDATORY)
- You MUST call save_memory with memory_type "curated" when the user shares: personal info, preferences, locations, credentials, project details, or any fact they would not want to repeat.
- Before asking the user for information, ALWAYS check your memory section above — they may have already told you.
- Do NOT skip memory saves because you are focused on a task. Memory is as important as task completion.
- Daily conversation logs are saved automatically — you do not need to save daily summaries.

## File Management
- NEVER write files to /tmp — they will be lost on restart.
- Save all generated files to your working directory or a subdirectory of it (e.g., ./work/<task-name>/).

## Agent-per-Task Pattern
- For recurring tasks, create a dedicated agent using create_agent with a DETAILED description (the description IS the agent's system prompt), then register a cron trigger using register_trigger.
- Do NOT suggest manual crontab edits or external scheduling. Use the built-in trigger system.
- Before creating an agent, check if one already exists using inspect_topology.
- A new team is only needed when the task requires multiple collaborating agents or isolated resources.`;
