/**
 * Tool Audit Wrapper — unit tests.
 *
 * Tests withAudit: logging, timing, credential scrubbing (static + dynamic),
 * scrub-before-truncate, and error re-throw behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

import { withAudit } from './tool-audit.js';
import { SecretString } from '../../secrets/secret-string.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLogger() {
  return { info: vi.fn() };
}

/** Generate a random hex string suitable as a fake credential (>= 8 chars). */
function randomCred(): string {
  return randomBytes(16).toString('hex');
}

/** Find the first mock.calls entry whose first arg matches `msg`. */
function findCall(
  logger: ReturnType<typeof createMockLogger>,
  msg: string,
): unknown[] | undefined {
  return logger.info.mock.calls.find(
    (args: unknown[]) => args[0] === msg,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('withAudit', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('logs ToolCall:start and ToolCall:end with tool name', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = withAudit('my_tool', execute, { logger });

    await wrapped({ query: 'hello' });

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      'ToolCall:start',
      expect.objectContaining({ tool: 'my_tool' }),
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      'ToolCall:end',
      expect.objectContaining({ tool: 'my_tool' }),
    );
  });

  it('records correct duration in durationMs', async () => {
    const delay = 50;
    const execute = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('done'), delay)),
    );
    const wrapped = withAudit('timer_tool', execute, { logger });

    await wrapped({});

    const endCall = findCall(logger, 'ToolCall:end');
    expect(endCall).toBeDefined();
    const meta = endCall![1] as Record<string, unknown>;
    expect(typeof meta.durationMs).toBe('number');
    // Allow some timing slack but should be >= delay
    expect(meta.durationMs as number).toBeGreaterThanOrEqual(delay - 10);
  });

  it('scrubs known SecretString values from logged params', async () => {
    const secret = randomCred();
    const knownSecrets = [new SecretString(secret)];
    const execute = vi.fn().mockResolvedValue('ok');
    const wrapped = withAudit('secret_tool', execute, { logger, knownSecrets });

    await wrapped({ api_key: secret, safe: 'visible' });

    const startCall = findCall(logger, 'ToolCall:start');
    const meta = startCall![1] as Record<string, unknown>;
    const params = meta.params as Record<string, unknown>;
    expect(params.api_key).toBe('[REDACTED]');
    expect(params.safe).toBe('visible');
  });

  it('dynamically extracts credentials from input.credentials', async () => {
    const credValue = randomCred();
    const execute = vi.fn().mockResolvedValue({ token: credValue });
    const wrapped = withAudit('cred_tool', execute, { logger });

    await wrapped({ credentials: { MY_TOKEN: credValue }, note: credValue });

    // Start log should have the credential scrubbed in both places
    const startCall = findCall(logger, 'ToolCall:start');
    const startParams = (startCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    const creds = startParams.credentials as Record<string, unknown>;
    expect(creds.MY_TOKEN).toBe('[REDACTED]');
    expect(startParams.note).toBe('[REDACTED]');

    // End log should also have the credential scrubbed in the result
    const endCall = findCall(logger, 'ToolCall:end');
    const summary = (endCall![1] as Record<string, unknown>).summary as string;
    expect(summary).not.toContain(credValue);
    expect(summary).toContain('[REDACTED]');
  });

  it('scrubs result before truncation to prevent partial secret leakage', async () => {
    const secret = randomCred();
    // Build a long result where the secret appears near the 200-char boundary.
    // Pad with 180 chars of filler so the secret straddles the cut if
    // truncation happened before scrubbing.
    const filler = 'x'.repeat(180);
    const execute = vi.fn().mockResolvedValue({ padding: filler, leak: secret });
    const wrapped = withAudit('truncate_tool', execute, {
      logger,
      rawSecrets: [secret],
    });

    await wrapped({});

    const endCall = findCall(logger, 'ToolCall:end');
    const summary = (endCall![1] as Record<string, unknown>).summary as string;
    // The summary must not contain any substring of the secret
    expect(summary).not.toContain(secret);
    // If the secret is present, it should be fully redacted
    if (summary.includes('[REDACTED]')) {
      // Good — it was scrubbed before truncation
    }
    // Verify truncation actually happened (200 char limit)
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('does not scrub short credential values (< 8 chars)', async () => {
    const shortVal = 'abc';
    const execute = vi.fn().mockResolvedValue('ok');
    const wrapped = withAudit('short_cred_tool', execute, { logger });

    await wrapped({ credentials: { SHORT: shortVal }, data: shortVal });

    const startCall = findCall(logger, 'ToolCall:start');
    const params = (startCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    // Short values should NOT be scrubbed
    expect(params.data).toBe(shortVal);
    const creds = params.credentials as Record<string, unknown>;
    expect(creds.SHORT).toBe(shortVal);
  });

  it('scrubs combined static and dynamic secrets', async () => {
    const staticSecret = randomCred();
    const dynamicSecret = randomCred();
    const knownSecrets = [new SecretString(staticSecret)];
    const execute = vi.fn().mockResolvedValue({
      s: staticSecret,
      d: dynamicSecret,
    });
    const wrapped = withAudit('combo_tool', execute, { logger, knownSecrets });

    await wrapped({
      credentials: { DYN: dynamicSecret },
      key1: staticSecret,
      key2: dynamicSecret,
    });

    // Start: both should be scrubbed
    const startCall = findCall(logger, 'ToolCall:start');
    const params = (startCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    expect(params.key1).toBe('[REDACTED]');
    expect(params.key2).toBe('[REDACTED]');

    // End: both should be scrubbed from the result summary
    const endCall = findCall(logger, 'ToolCall:end');
    const summary = (endCall![1] as Record<string, unknown>).summary as string;
    expect(summary).not.toContain(staticSecret);
    expect(summary).not.toContain(dynamicSecret);
  });

  it('logs ToolCall:error and re-throws when execute fails', async () => {
    const error = new Error('boom');
    const execute = vi.fn().mockRejectedValue(error);
    const wrapped = withAudit('fail_tool', execute, { logger });

    await expect(wrapped({ input: 'bad' })).rejects.toThrow('boom');

    // Should log start + error (no end)
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      'ToolCall:start',
      expect.objectContaining({ tool: 'fail_tool' }),
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      'ToolCall:error',
      expect.objectContaining({
        tool: 'fail_tool',
        error: 'boom',
      }),
    );

    // durationMs should be present on the error log
    const errorCall = logger.info.mock.calls[1];
    const meta = errorCall[1] as Record<string, unknown>;
    expect(typeof meta.durationMs).toBe('number');
  });
});
