/**
 * Task-consumer notify-decision helpers.
 *
 * Trigger-originated tasks append an instruction asking the LLM to decide
 * whether the user should be notified about the result. The decision is
 * returned in a ```json:notify block. These helpers parse that block out
 * of the response and strip it before the response is stored / delivered.
 */

import { safeJsonParse } from '../domain/safe-json.js';

/** Regex to extract the notify JSON block (```json:notify ... ```) from LLM response. */
const NOTIFY_BLOCK_RE = /```json:notify\s*(\{[^}]*"notify"\s*:\s*(?:true|false)[^}]*\})\s*```/s;

/** Instruction appended to trigger-originated tasks so the LLM decides whether to notify. */
export const TRIGGER_NOTIFY_INSTRUCTION = `
---
## Notification Decision
This task was triggered automatically. After completing it, decide whether the user should be notified about this result.

At the END of your response, include a JSON block with your decision:

\`\`\`json:notify
{"notify": true, "reason": "Brief reason for your decision"}
\`\`\`

Set \`notify\` to \`true\` if the result has new, important, or actionable information the user should see.
Set \`notify\` to \`false\` if the result is routine, unchanged, or not worth interrupting the user.

Ask yourself: Is there something genuinely new? Did something fail unexpectedly? Would the user want to act on this? When in doubt, notify.`;

/**
 * Parse the LLM's notification decision from a ```json:notify block.
 * Fail-safe: returns { notify: true } if missing, malformed, or unparseable.
 */
export function parseLlmNotifyDecision(text: string | undefined): { notify: boolean; reason?: string } {
  if (!text) return { notify: true };
  const match = text.match(NOTIFY_BLOCK_RE);
  if (!match) return { notify: true };
  const parsed = safeJsonParse<{ notify: boolean; reason?: string }>(match[1], 'notify-decision');
  if (!parsed || typeof parsed.notify !== 'boolean') return { notify: true };
  return { notify: parsed.notify, reason: parsed.reason };
}

/**
 * Strip the notify JSON block and any echoed instruction from displayed/stored content.
 * Removes ```json:notify blocks and <notify_decision>...</notify_decision> tags.
 */
export function stripNotifyBlock(text: string): string {
  // Strip <notify_decision>...</notify_decision> tags (may wrap the block)
  let cleaned = text.replace(/<notify_decision>[\s\S]*?<\/notify_decision>/g, '');

  // Try removing from the "---\n## Notification Decision" marker onward
  const sectionStripped = cleaned.replace(/\n---\n## Notification Decision[\s\S]*$/, '').trim();
  if (sectionStripped && sectionStripped !== cleaned.trim()) {
    return sectionStripped;
  }

  // Fallback: just remove the json:notify block itself
  cleaned = cleaned.replace(NOTIFY_BLOCK_RE, '').trim();
  return cleaned;
}
