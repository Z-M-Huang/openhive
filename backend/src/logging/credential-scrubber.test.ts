/**
 * Credential scrubber + Logger tests (migrated from layer-1.test.ts)
 *
 * UT-13: Credential scrubber known values and patterns
 * UT-24: Logger smoke test
 */

import { describe, it, expect } from 'vitest';

import { SecretString } from '../secrets/secret-string.js';
import { scrubSecrets, createStderrScrubber } from './credential-scrubber.js';
import { createLogger } from './logger.js';

// ── UT-13: Credential Scrubber ─────────────────────────────────────────────

describe('UT-13: Credential Scrubber', () => {
  it('scrubs known secret values', () => {
    const secret = new SecretString('my-api-key-12345');
    const text = 'Authorization: my-api-key-12345 is used here';
    const scrubbed = scrubSecrets(text, [secret]);
    expect(scrubbed).not.toContain('my-api-key-12345');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs sk- prefixed keys', () => {
    const text = 'key is sk-abcdefghijklmnopqrstuvwxyz in logs';
    const scrubbed = scrubSecrets(text, []);
    expect(scrubbed).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs Bearer tokens', () => {
    const text = 'Header: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const scrubbed = scrubSecrets(text, []);
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs token= parameters', () => {
    const text = 'url?token=abc123def456&foo=bar';
    const scrubbed = scrubSecrets(text, []);
    expect(scrubbed).not.toContain('token=abc123def456');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('handles empty secrets list', () => {
    const text = 'no secrets here';
    expect(scrubSecrets(text, [])).toBe('no secrets here');
  });

  it('createStderrScrubber returns a working scrubber', () => {
    const secret = new SecretString('secret-val');
    const scrubber = createStderrScrubber([secret]);
    // scrubber returns void (logs internally) — just verify it doesn't throw
    expect(() => scrubber('error: secret-val leaked')).not.toThrow();
  });
});

// ── Credential redaction with raw secrets (migrated from layer-5.test.ts) ──

describe('Credential redaction with raw secrets', () => {
  it('scrubs team credential values from text', () => {
    const testToken = 'test-fake-token-for-redaction-test';
    const result = scrubSecrets(
      `Calling API with token ${testToken}`,
      [],
      [testToken],
    );
    expect(result).not.toContain(testToken);
    expect(result).toContain('[REDACTED]');
  });

  it('does not redact short values (< 8 chars)', () => {
    const result = scrubSecrets('subdomain is prod', [], ['prod']);
    expect(result).toContain('prod');
  });
});

// ── UT-24: Logger Smoke Test ───────────────────────────────────────────────

describe('UT-24: Logger', () => {
  it('creates a logger with all standard methods', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('accepts custom level option without error', () => {
    const logger = createLogger({ level: 'debug' });
    expect(logger).toBeDefined();
  });
});
