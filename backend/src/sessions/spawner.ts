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

/** Function signature matching SDK query(). */
export type QueryFn = (
  prompt: string,
  options: Record<string, unknown>,
) => AsyncIterable<SdkMessage>;

/**
 * Spawn a session: call query() and collect all messages.
 *
 * @param prompt    The task/prompt to send to the agent.
 * @param options   Assembled query options (passed through to queryFn).
 * @param queryFn   SDK query function (injected for testing).
 */
export async function spawnSession(
  prompt: string,
  options: object,
  queryFn: QueryFn,
): Promise<SpawnResult> {
  const messages: SdkMessage[] = [];
  const opts = options as Record<string, unknown>;

  for await (const msg of queryFn(prompt, opts)) {
    messages.push(msg);
  }

  return { messages };
}
