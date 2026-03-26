/**
 * Session spawner — thin wrapper around the Claude Agent SDK query().
 *
 * Accepts a queryFn for dependency injection (testability).
 */

/** Minimal SDK message shape. */
export interface SdkMessage {
  readonly type: string;
  readonly content?: unknown;
}

/** Result of a session spawn. */
export interface SpawnResult {
  readonly messages: SdkMessage[];
}

/**
 * QueryFn signature for testing — takes (prompt, options) separately.
 * The real SDK query takes { prompt, options: {...} } but we wrap it.
 */
export type QueryFn = (
  prompt: string,
  options: Record<string, unknown>,
) => AsyncIterable<SdkMessage>;

// ── Progressive response types ───────────────────────────────────────────

/** Callback for streaming progress updates during a session. */
export type ProgressCallback = (update: ProgressUpdate) => void;

/** A progress update emitted during session execution. */
export interface ProgressUpdate {
  readonly kind: 'assistant_text' | 'tool_active' | 'tool_summary';
  readonly content: string;
}

/**
 * Extract the content blocks from an SDK assistant message.
 * SDK shape: SDKAssistantMessage has msg.message (BetaMessage), NOT msg.content.
 *
 * Centralizes the one unsafe access so both spawner and message-handler
 * go through a single function if the SDK shape ever changes.
 */
export function getAssistantContentBlocks(
  msg: SdkMessage,
): Array<{ type: string; text?: string }> | null {
  if (msg.type !== 'assistant') return null;
  const raw = msg as unknown as Record<string, unknown>;
  const betaMsg = raw['message'];
  if (typeof betaMsg !== 'object' || betaMsg === null) return null;
  const content = (betaMsg as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  return content as Array<{ type: string; text?: string }>;
}

function extractAssistantText(msg: SdkMessage): string | null {
  const blocks = getAssistantContentBlocks(msg);
  if (!blocks) return null;
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text' && block.text) text += block.text;
  }
  return text || null;
}

/**
 * Extract a progress update from an SDK message, if applicable.
 *
 * - First `assistant` message → assistant_text (never throttled)
 * - `tool_progress` → tool_active (subject to caller's throttle)
 * - `tool_use_summary` → tool_summary (always emitted — infrequent)
 */
function extractProgress(
  msg: SdkMessage,
  throttleOk: boolean,
  firstAssistantSent: boolean,
): ProgressUpdate | null {
  // First assistant text — always emit, regardless of throttle
  if (msg.type === 'assistant' && !firstAssistantSent) {
    const text = extractAssistantText(msg);
    if (text) return { kind: 'assistant_text', content: text };
  }

  // Tool progress — subject to throttle
  if (msg.type === 'tool_progress' && throttleOk) {
    const raw = msg as unknown as Record<string, unknown>;
    const toolName = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : 'tool';
    const elapsed = typeof raw['elapsed_time_seconds'] === 'number'
      ? Math.round(raw['elapsed_time_seconds'])
      : undefined;
    const suffix = elapsed !== undefined ? ` (${elapsed}s)` : '';
    return { kind: 'tool_active', content: `Working with ${toolName}${suffix}` };
  }

  // Tool use summary — always emit (infrequent)
  if (msg.type === 'tool_use_summary') {
    const raw = msg as unknown as Record<string, unknown>;
    const summary = typeof raw['summary'] === 'string' ? raw['summary'] : '';
    if (summary) return { kind: 'tool_summary', content: summary };
  }

  return null;
}

/**
 * Spawn a session: call query() and collect all messages.
 *
 * @param prompt      The task/prompt to send to the agent.
 * @param options     Assembled query options (passed through to queryFn).
 * @param queryFn     SDK query function (injected for testing).
 * @param onProgress  Optional callback for streaming progress updates.
 */
export async function spawnSession(
  prompt: string,
  options: object,
  queryFn: QueryFn,
  onProgress?: ProgressCallback,
): Promise<SpawnResult> {
  const messages: SdkMessage[] = [];
  const opts = options as Record<string, unknown>;
  let lastToolProgressAt = 0;
  let firstAssistantSent = false;

  for await (const msg of queryFn(prompt, opts)) {
    messages.push(msg);
    if (onProgress) {
      const now = Date.now();
      // Throttle only applies to tool_active/tool_summary, not assistant_text
      const throttleOk = now - lastToolProgressAt >= 10_000;
      const update = extractProgress(msg, throttleOk, firstAssistantSent);
      if (update) {
        onProgress(update);
        if (update.kind !== 'assistant_text') lastToolProgressAt = now;
        if (update.kind === 'assistant_text') firstAssistantSent = true;
      }
    }
  }

  return { messages };
}
