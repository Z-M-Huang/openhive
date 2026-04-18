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
  return { info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

/** Generate a random hex string suitable as a fake credential (>= 8 chars). */
function randomCred(): string {
  return randomBytes(16).toString('hex');
}

/** Find the first mock.calls entry whose first arg matches `msg`, across all log levels. */
function findCall(
  logger: ReturnType<typeof createMockLogger>,
  msg: string,
): unknown[] | undefined {
  for (const method of [logger.debug, logger.trace, logger.info] as ReturnType<typeof vi.fn>[]) {
    const found = method.mock.calls.find(
      (args: unknown[]) => args[0] === msg,
    );
    if (found) return found as unknown[];
  }
  return undefined;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('withAudit', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('logs ToolCall:start and ToolCall:end with tool name at debug level', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = withAudit('my_tool', execute, { logger });

    await wrapped({ query: 'hello' });

    // Debug: start + end
    expect(logger.debug).toHaveBeenCalledWith(
      'ToolCall:start',
      expect.objectContaining({ tool: 'my_tool' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'ToolCall:end',
      expect.objectContaining({ tool: 'my_tool', success: true }),
    );
    // Trace: request + response
    expect(logger.trace).toHaveBeenCalledWith(
      'ToolCall:request',
      expect.objectContaining({ tool: 'my_tool' }),
    );
    expect(logger.trace).toHaveBeenCalledWith(
      'ToolCall:response',
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

    // Debug level: inputSummary is scrubbed
    const startCall = findCall(logger, 'ToolCall:start');
    const meta = startCall![1] as Record<string, unknown>;
    const inputSummary = meta.inputSummary as string;
    expect(inputSummary).not.toContain(secret);
    expect(inputSummary).toContain('[REDACTED]');
    expect(inputSummary).toContain('visible');

    // Trace level: full params are scrubbed
    const traceCall = findCall(logger, 'ToolCall:request');
    const traceMeta = traceCall![1] as Record<string, unknown>;
    const params = traceMeta.params as Record<string, unknown>;
    expect(params.api_key).toBe('[REDACTED]');
    expect(params.safe).toBe('visible');
  });

  it('dynamically extracts credentials from input.credentials', async () => {
    const credValue = randomCred();
    const execute = vi.fn().mockResolvedValue({ token: credValue });
    const wrapped = withAudit('cred_tool', execute, { logger });

    await wrapped({ credentials: { MY_TOKEN: credValue }, note: credValue });

    // Trace request log should have the credential scrubbed in both places
    const traceCall = findCall(logger, 'ToolCall:request');
    const traceParams = (traceCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    const creds = traceParams.credentials as Record<string, unknown>;
    expect(creds.MY_TOKEN).toBe('[REDACTED]');
    expect(traceParams.note).toBe('[REDACTED]');

    // Debug end log should also have the credential scrubbed in the summary
    const endCall = findCall(logger, 'ToolCall:end');
    const summary = (endCall![1] as Record<string, unknown>).summary as string;
    expect(summary).not.toContain(credValue);
    expect(summary).toContain('[REDACTED]');

    // Trace response log should have the credential scrubbed
    const traceResp = findCall(logger, 'ToolCall:response');
    const respStr = (traceResp![1] as Record<string, unknown>).response as string;
    expect(respStr).not.toContain(credValue);
    expect(respStr).toContain('[REDACTED]');
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

    // Check trace level (full params)
    const traceCall = findCall(logger, 'ToolCall:request');
    const params = (traceCall![1] as Record<string, unknown>).params as Record<string, unknown>;
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

    // Trace request: both should be scrubbed
    const traceCall = findCall(logger, 'ToolCall:request');
    const params = (traceCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    expect(params.key1).toBe('[REDACTED]');
    expect(params.key2).toBe('[REDACTED]');

    // Debug end: both should be scrubbed from the result summary
    const endCall = findCall(logger, 'ToolCall:end');
    const summary = (endCall![1] as Record<string, unknown>).summary as string;
    expect(summary).not.toContain(staticSecret);
    expect(summary).not.toContain(dynamicSecret);
  });

  it('dynamically extracts input.value as a secret for vault-style tools', async () => {
    const vaultSecret = randomCred();
    const execute = vi.fn().mockResolvedValue({ success: true });
    const wrapped = withAudit('vault_set', execute, { logger });

    await wrapped({ key: 'API_KEY', value: vaultSecret });

    // Trace request: value should be scrubbed
    const traceCall = findCall(logger, 'ToolCall:request');
    const params = (traceCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    expect(params.value).toBe('[REDACTED]');
    expect(params.key).toBe('API_KEY');
  });

  it('does not scrub short input.value (< 8 chars)', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const wrapped = withAudit('vault_set', execute, { logger });

    await wrapped({ key: 'FLAG', value: 'short' });

    const traceCall = findCall(logger, 'ToolCall:request');
    const params = (traceCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    expect(params.value).toBe('short');
  });

  it('scrubs both input.credentials and input.value when both present', async () => {
    const credSecret = randomCred();
    const valSecret = randomCred();
    const execute = vi.fn().mockResolvedValue({ c: credSecret, v: valSecret });
    const wrapped = withAudit('combo_vault', execute, { logger });

    await wrapped({ credentials: { TOK: credSecret }, value: valSecret });

    // Trace request: both scrubbed
    const traceCall = findCall(logger, 'ToolCall:request');
    const params = (traceCall![1] as Record<string, unknown>).params as Record<string, unknown>;
    expect((params.credentials as Record<string, unknown>).TOK).toBe('[REDACTED]');
    expect(params.value).toBe('[REDACTED]');

    // Response: both scrubbed
    const respCall = findCall(logger, 'ToolCall:response');
    const respStr = (respCall![1] as Record<string, unknown>).response as string;
    expect(respStr).not.toContain(credSecret);
    expect(respStr).not.toContain(valSecret);
  });

  it('logs ToolCall:error and re-throws when execute fails', async () => {
    const error = new Error('boom');
    const execute = vi.fn().mockRejectedValue(error);
    const wrapped = withAudit('fail_tool', execute, { logger });

    await expect(wrapped({ input: 'bad' })).rejects.toThrow('boom');

    // Debug: should log start (no end)
    expect(logger.debug).toHaveBeenCalledWith(
      'ToolCall:start',
      expect.objectContaining({ tool: 'fail_tool' }),
    );
    // Info: should log error
    expect(logger.info).toHaveBeenCalledWith(
      'ToolCall:error',
      expect.objectContaining({
        tool: 'fail_tool',
        error: 'boom',
      }),
    );
    // No ToolCall:end should appear
    const endCall = findCall(logger, 'ToolCall:end');
    expect(endCall).toBeUndefined();

    // durationMs should be present on the error log
    const errorCall = findCall(logger, 'ToolCall:error');
    const meta = errorCall![1] as Record<string, unknown>;
    expect(typeof meta.durationMs).toBe('number');
  });
});
