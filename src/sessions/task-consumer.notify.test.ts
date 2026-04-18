/**
 * Unit 1: Parser Functions for LLM-based Trigger Notification
 *
 * Tests for parseLlmNotifyDecision and stripNotifyBlock.
 * These functions will be exported from task-consumer.ts in Unit 2.
 *
 * RED tests — implementations do not exist yet.
 */

import { describe, it, expect } from 'vitest';

import {
  parseLlmNotifyDecision,
  stripNotifyBlock,
} from './task-consumer.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Realistic LLM response with a notify-true decision embedded. */
const RESPONSE_WITH_NOTIFY_TRUE = `Here is the daily summary of repository activity.

There were 3 new pull requests opened today, 2 of which have failing CI checks.
The deployment pipeline for staging is currently blocked due to a flaky test.

\`\`\`json:notify
{"notify": true, "reason": "CI failures and blocked staging pipeline require human attention"}
\`\`\``;

/** Realistic LLM response with a notify-false decision. */
const RESPONSE_WITH_NOTIFY_FALSE = `I checked the monitoring dashboard and all systems are operating normally.

CPU usage is at 23%, memory at 41%, and there are no error spikes in the logs.
Everything looks healthy.

\`\`\`json:notify
{"notify": false, "reason": "All systems nominal, no action needed"}
\`\`\``;

/** Response where the LLM did not include any JSON block at all. */
const RESPONSE_NO_BLOCK = `The scheduled backup completed successfully.

All 14 tables were backed up in 2.3 seconds. No issues detected.`;

/** Response with malformed JSON inside the notify block. */
const RESPONSE_MALFORMED_JSON = `Scan complete. Found 2 vulnerabilities.

\`\`\`json:notify
{notify: true, reason: "missing quotes on keys"}
\`\`\``;

/** Response where JSON is valid but missing the notify key. */
const RESPONSE_MISSING_NOTIFY_KEY = `Report generated.

\`\`\`json:notify
{"reason": "something happened", "severity": "high"}
\`\`\``;

/** Response where notify is a string instead of boolean. */
const RESPONSE_NOTIFY_STRING = `Check complete.

\`\`\`json:notify
{"notify": "true", "reason": "string instead of boolean"}
\`\`\``;

/** Response with multiple JSON blocks, only one matching notify pattern. */
const RESPONSE_MULTIPLE_BLOCKS = `Here is the analysis:

\`\`\`json
{"data": [1, 2, 3], "total": 6}
\`\`\`

The above is raw data. My notification decision:

\`\`\`json:notify
{"notify": false, "reason": "routine data, no anomalies"}
\`\`\``;

/** Response where the notify block is the entire content. */
const RESPONSE_ONLY_BLOCK = `\`\`\`json:notify
{"notify": true, "reason": "critical alert"}
\`\`\``;

/** Response that echoes back the instruction text before the block. */
const RESPONSE_WITH_ECHOED_INSTRUCTION = `<notify_decision>
Based on the task output, I need to decide whether to notify the user.

\`\`\`json:notify
{"notify": true, "reason": "deploy failed"}
\`\`\`
</notify_decision>

The deployment to production failed with exit code 1.`;

// ── parseLlmNotifyDecision ──────────────────────────────────────────────────

describe('parseLlmNotifyDecision', () => {
  it('parses notify: true with reason', () => {
    const result = parseLlmNotifyDecision(RESPONSE_WITH_NOTIFY_TRUE);
    expect(result).toEqual({
      notify: true,
      reason: 'CI failures and blocked staging pipeline require human attention',
    });
  });

  it('parses notify: false with reason', () => {
    const result = parseLlmNotifyDecision(RESPONSE_WITH_NOTIFY_FALSE);
    expect(result).toEqual({
      notify: false,
      reason: 'All systems nominal, no action needed',
    });
  });

  it('returns fail-safe {notify: true} when no JSON block is present', () => {
    const result = parseLlmNotifyDecision(RESPONSE_NO_BLOCK);
    expect(result).toEqual({ notify: true });
  });

  it('returns fail-safe {notify: true} for malformed JSON in block', () => {
    const result = parseLlmNotifyDecision(RESPONSE_MALFORMED_JSON);
    expect(result).toEqual({ notify: true });
  });

  it('returns fail-safe {notify: true} when notify key is missing from valid JSON', () => {
    const result = parseLlmNotifyDecision(RESPONSE_MISSING_NOTIFY_KEY);
    expect(result).toEqual({ notify: true });
  });

  it('returns fail-safe {notify: true} when notify is a string instead of boolean', () => {
    const result = parseLlmNotifyDecision(RESPONSE_NOTIFY_STRING);
    expect(result).toEqual({ notify: true });
  });

  it('returns fail-safe {notify: true} for empty string input', () => {
    const result = parseLlmNotifyDecision('');
    expect(result).toEqual({ notify: true });
  });

  it('returns fail-safe {notify: true} for null/undefined input', () => {
    const result = parseLlmNotifyDecision(null as unknown as string);
    expect(result).toEqual({ notify: true });
    const result2 = parseLlmNotifyDecision(undefined as unknown as string);
    expect(result2).toEqual({ notify: true });
  });

  it('uses the json:notify block when multiple JSON blocks exist', () => {
    const result = parseLlmNotifyDecision(RESPONSE_MULTIPLE_BLOCKS);
    expect(result).toEqual({
      notify: false,
      reason: 'routine data, no anomalies',
    });
  });

  // ── No-op tick contract (ADR-42) ────────────────────────────────────────────

  it('returns {notify: false, reason: "noop"} when the response contains {"action":"noop"}', () => {
    const result = parseLlmNotifyDecision('Window checked. No changes detected.\n\n{"action":"noop"}');
    expect(result).toEqual({ notify: false, reason: 'noop' });
  });

  it('detects noop inside a code-fenced json block', () => {
    const text = 'No new updates.\n\n```json\n{"action":"noop"}\n```';
    expect(parseLlmNotifyDecision(text)).toEqual({ notify: false, reason: 'noop' });
  });

  it('detects noop when extra fields are present in the action object', () => {
    const text = '{"action":"noop", "reason":"no diff since last tick"}';
    expect(parseLlmNotifyDecision(text)).toEqual({ notify: false, reason: 'noop' });
  });

  it('noop action takes precedence over a notify-true block', () => {
    const text = `Some content.

{"action":"noop"}

\`\`\`json:notify
{"notify": true, "reason": "would have notified"}
\`\`\``;
    expect(parseLlmNotifyDecision(text)).toEqual({ notify: false, reason: 'noop' });
  });
});

// ── stripNotifyBlock ────────────────────────────────────────────────────────

describe('stripNotifyBlock', () => {
  it('removes the notify block and preserves surrounding text', () => {
    const stripped = stripNotifyBlock(RESPONSE_WITH_NOTIFY_TRUE);
    expect(stripped).not.toContain('```json');
    expect(stripped).not.toContain('"notify"');
    expect(stripped).toContain('There were 3 new pull requests opened today');
    expect(stripped).toContain('blocked due to a flaky test');
  });

  it('returns the response unchanged when no notify block exists', () => {
    const stripped = stripNotifyBlock(RESPONSE_NO_BLOCK);
    expect(stripped).toBe(RESPONSE_NO_BLOCK);
  });

  it('returns empty string when the block is the entire content', () => {
    const stripped = stripNotifyBlock(RESPONSE_ONLY_BLOCK);
    expect(stripped.trim()).toBe('');
  });

  it('removes echoed instruction text along with the block', () => {
    const stripped = stripNotifyBlock(RESPONSE_WITH_ECHOED_INSTRUCTION);
    expect(stripped).not.toContain('<notify_decision>');
    expect(stripped).not.toContain('</notify_decision>');
    expect(stripped).not.toContain('```json');
    // The actual task output should remain
    expect(stripped).toContain('The deployment to production failed with exit code 1');
  });
});
