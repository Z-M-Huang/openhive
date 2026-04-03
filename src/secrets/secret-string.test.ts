/**
 * SecretString tests (migrated from layer-1.test.ts)
 *
 * UT-11: SecretString expose/redaction
 */

import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';

import { SecretString } from './secret-string.js';

// ── UT-11: SecretString ────────────────────────────────────────────────────

describe('UT-11: SecretString', () => {
  const raw = 'super-secret-api-key-12345';
  const secret = new SecretString(raw);

  it('expose() returns the raw value', () => {
    expect(secret.expose()).toBe(raw);
  });

  it('toString() returns [REDACTED]', () => {
    expect(secret.toString()).toBe('[REDACTED]');
  });

  it('toJSON() returns [REDACTED]', () => {
    expect(secret.toJSON()).toBe('[REDACTED]');
    expect(JSON.stringify({ key: secret })).toBe('{"key":"[REDACTED]"}');
  });

  it('Symbol.toPrimitive returns [REDACTED]', () => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`${secret}`).toBe('[REDACTED]');
  });

  it('util.inspect returns [REDACTED]', () => {
    expect(inspect(secret)).toBe('[REDACTED]');
  });

  it('prototype is frozen', () => {
    expect(Object.isFrozen(SecretString.prototype)).toBe(true);
  });

  it('instance is frozen', () => {
    expect(Object.isFrozen(secret)).toBe(true);
  });
});
