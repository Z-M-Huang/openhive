/**
 * AI Engine — session runner using Vercel AI SDK 6.
 * Replaces spawner.ts + sdk.query() with streamText().
 */
import { streamText, generateText, stepCountIs } from 'ai';
import type { ToolSet, SystemModelMessage } from 'ai';
import type { LanguageModel } from 'ai';
import { scrubSecrets } from '../logging/credential-scrubber.js';
import type { SecretString } from '../secrets/secret-string.js';
import type { SystemPromptParts } from './prompt-builder.js';

// ── Progress types (backward-compat with spawner.ts consumers) ──────────────

/** A progress update emitted during session execution. */
export interface ProgressUpdate {
  readonly kind: 'assistant_text' | 'tool_active' | 'tool_summary';
  readonly content: string;
}

/** Callback for streaming progress updates during a session. */
export type ProgressCallback = (update: ProgressUpdate) => void;

// ── Options & result ────────────────────────────────────────────────────────

export interface AiEngineOpts {
  /** Resolved language model from provider registry. */
  readonly model: LanguageModel;
  /** Full system prompt (from prompt-builder). String or two-part for cache hints. */
  readonly system: string | SystemPromptParts;
  /** The user's prompt/task. */
  readonly prompt: string;
  /** All available tools (built-in + MCP + subagent). */
  readonly tools: ToolSet;
  /** Subset of tool names the model may use. */
  readonly activeTools: string[];
  /** Maximum tool-loop steps. */
  readonly maxTurns: number;
  /** Context window size for prepareStep compression. */
  readonly contextWindow: number;
  /** Summarization model (can be same or cheaper model). */
  readonly summaryModel?: LanguageModel;
  /** Known secrets for scrubbing (SecretString instances). */
  readonly knownSecrets?: readonly SecretString[];
  /** Raw secret strings for scrubbing. */
  readonly rawSecrets?: readonly string[];
  /** Progress callback. */
  readonly onProgress?: ProgressCallback;
}

export interface AiEngineResult {
  readonly text: string;
  readonly steps: number;
  /** True if output was scrubbed of known secrets. */
  readonly scrubbed: boolean;
}

// ── Rough token estimator ───────────────────────────────────────────────────

/** Rough token estimation: chars / 4. Exported for testing. */
export function estimateTokens(messages: unknown[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += JSON.stringify(msg).length;
  }
  return Math.ceil(chars / 4);
}

// ── Session runner ──────────────────────────────────────────────────────────

/**
 * Run a single AI session using streamText().
 *
 * Handles:
 * - Tool loop with step count limit (stopWhen)
 * - Progress callbacks (assistant_text, tool_summary)
 * - Context compression via prepareStep when approaching context window
 * - Secret scrubbing on final output
 */
/**
 * Build the `system` value for streamText().
 * - Plain string → pass through as-is.
 * - Two-part object → Array<SystemModelMessage> with Anthropic cache_control
 *   on the static prefix. Non-Anthropic providers ignore providerOptions gracefully.
 *
 * The AI SDK accepts `system` as `string | SystemModelMessage | SystemModelMessage[]`.
 * SystemModelMessage = { role: 'system'; content: string; providerOptions?: ... }
 */
export function resolveSystemPrompt(
  system: string | SystemPromptParts,
): string | SystemModelMessage[] {
  if (typeof system === 'string') return system;

  // Two-part: use SystemModelMessage array with Anthropic cache hints
  const parts: SystemModelMessage[] = [];
  if (system.staticPrefix) {
    parts.push({
      role: 'system',
      content: system.staticPrefix,
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    });
  }
  if (system.dynamicSuffix) {
    parts.push({ role: 'system', content: system.dynamicSuffix });
  }
  // Fallback: if both are empty, return empty string
  if (parts.length === 0) return '';
  return parts;
}

export async function runSession(opts: AiEngineOpts): Promise<AiEngineResult> {
  let firstAssistantSent = false;

  const result = streamText({
    model: opts.model,
    system: resolveSystemPrompt(opts.system),
    prompt: opts.prompt,
    tools: opts.tools,
    activeTools: opts.activeTools,
    stopWhen: stepCountIs(opts.maxTurns),

    onStepFinish(event) {
      // First assistant text → ack
      if (event.text && !firstAssistantSent && opts.onProgress) {
        opts.onProgress({ kind: 'assistant_text', content: event.text });
        firstAssistantSent = true;
      }

      // Tool call summaries
      if (event.toolCalls && event.toolCalls.length > 0 && opts.onProgress) {
        for (const tc of event.toolCalls) {
          opts.onProgress({
            kind: 'tool_summary',
            content: `Used ${tc.toolName}`,
          });
        }
      }
    },

    prepareStep({ messages }) {
      // Context compression at 90% of window
      const estimatedToks = estimateTokens(messages);
      if (estimatedToks < opts.contextWindow * 0.9) {
        return undefined;
      }

      // When over threshold, summarize older messages using the summary model.
      // We return a promise since generateText is async.
      const summaryModel = opts.summaryModel ?? opts.model;
      const recentCount = 5;
      const oldMessages = messages.slice(0, -recentCount);
      const recentMessages = messages.slice(-recentCount);

      return generateText({
        model: summaryModel,
        system:
          'Summarize preserving: pending tasks, decisions, key tool outputs, errors.',
        messages: oldMessages,
      }).then((summary) => ({
        messages: [
          {
            role: 'user' as const,
            content: `[Previous conversation summary]\n${summary.text}`,
          },
          ...recentMessages,
        ],
      }));
    },
  });

  // Consume the stream and get the final text
  const finalText = await result.text;
  const allSteps = await result.steps;

  // Fallback when step limit reached with no final text
  let outputText = finalText;
  if (!outputText && allSteps.length >= opts.maxTurns) {
    outputText = `[Session completed after ${allSteps.length} tool steps without a final response. The task may be partially complete — check tool outputs above.]`;
  }

  // Scrub secrets from the final output
  let scrubbed = false;
  if (opts.knownSecrets?.length || opts.rawSecrets?.length) {
    const cleaned = scrubSecrets(
      outputText,
      opts.knownSecrets ?? [],
      opts.rawSecrets,
    );
    if (cleaned !== outputText) {
      scrubbed = true;
      outputText = cleaned;
    }
  }

  return {
    text: outputText,
    steps: allSteps.length,
    scrubbed,
  };
}
