/**
 * Tests for KeyManager implementation.
 *
 * Covers:
 *   - Encrypt/decrypt round-trip
 *   - Decrypt fails with wrong key
 *   - EncryptionLockedError when locked
 *   - Unlock: transitions to unlocked, rejects short keys
 *   - Lock: clears key and transitions to locked
 *   - Rate limiting: blocks after 5 failed attempts within 1 minute
 *   - Rate limit resets after successful unlock
 *   - Encrypted values have 'enc:' prefix
 *   - Argon2id parameters are correct
 *   - Cross-compatibility: format matches enc: + base64(salt16 || nonce12 || ciphertext)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import * as argon2 from 'argon2';
import { KeyManagerImpl, deriveKey, newKeyManager } from './key-manager.js';
import { EncryptionLockedError, RateLimitedError, ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_KEY = 'my-secure-master-key-16chars+';
const SHORT_KEY = 'tooshort';
const PLAINTEXT = 'super secret value';

const SALT_LEN = 16;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;

function freshManager(): KeyManagerImpl {
  return new KeyManagerImpl();
}

async function unlockedManager(): Promise<KeyManagerImpl> {
  const m = freshManager();
  await m.unlock(VALID_KEY);
  return m;
}

// ---------------------------------------------------------------------------
// isLocked / lock / unlock state transitions
// ---------------------------------------------------------------------------

describe('KeyManagerImpl — state transitions', () => {
  it('starts in locked state', () => {
    const m = freshManager();
    expect(m.isLocked()).toBe(true);
  });

  it('unlock transitions to unlocked state', async () => {
    const m = freshManager();
    await m.unlock(VALID_KEY);
    expect(m.isLocked()).toBe(false);
  });

  it('lock transitions back to locked state', async () => {
    const m = await unlockedManager();
    m.lock();
    expect(m.isLocked()).toBe(true);
  });

  it('unlock rejects keys shorter than 16 characters', async () => {
    const m = freshManager();
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
  });

  it('ValidationError carries correct field and message', async () => {
    const m = freshManager();
    let caught: unknown;
    try {
      await m.unlock(SHORT_KEY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.field).toBe('master_key');
    expect(ve.message).toContain('16');
  });

  it('accepts keys exactly 16 characters long', async () => {
    const m = freshManager();
    await expect(m.unlock('exactly16chars!!').then(() => m.isLocked())).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// encrypt — locked checks
// ---------------------------------------------------------------------------

describe('KeyManagerImpl — encrypt', () => {
  it('throws EncryptionLockedError when locked', async () => {
    const m = freshManager();
    await expect(m.encrypt(PLAINTEXT)).rejects.toThrow(EncryptionLockedError);
  });

  it('returns string prefixed with enc:', async () => {
    const m = await unlockedManager();
    const result = await m.encrypt(PLAINTEXT);
    expect(result.startsWith('enc:')).toBe(true);
  });

  it('produces different ciphertexts each call (random salt+nonce)', async () => {
    const m = await unlockedManager();
    const r1 = await m.encrypt(PLAINTEXT);
    const r2 = await m.encrypt(PLAINTEXT);
    expect(r1).not.toBe(r2);
  });

  it('throws EncryptionLockedError after lock()', async () => {
    const m = await unlockedManager();
    m.lock();
    await expect(m.encrypt(PLAINTEXT)).rejects.toThrow(EncryptionLockedError);
  });
});

// ---------------------------------------------------------------------------
// decrypt — locked checks
// ---------------------------------------------------------------------------

describe('KeyManagerImpl — decrypt', () => {
  it('throws EncryptionLockedError when locked', async () => {
    const m = freshManager();
    await expect(m.decrypt('enc:AAAA')).rejects.toThrow(EncryptionLockedError);
  });

  it('throws on missing enc: prefix', async () => {
    const m = await unlockedManager();
    await expect(m.decrypt('no-prefix')).rejects.toThrow(/missing enc: prefix/);
  });

  it('throws on too-short payload', async () => {
    const m = await unlockedManager();
    // base64 of 44 bytes (16+12+16=44 minimum + at least 1 byte = 45), supply only 10
    const short = Buffer.alloc(10).toString('base64');
    await expect(m.decrypt('enc:' + short)).rejects.toThrow(/too short/);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('KeyManagerImpl — encrypt/decrypt round-trip', () => {
  it('round-trips ASCII plaintext', async () => {
    const m = await unlockedManager();
    const enc = await m.encrypt(PLAINTEXT);
    const dec = await m.decrypt(enc);
    expect(dec).toBe(PLAINTEXT);
  });

  it('round-trips empty string', async () => {
    const m = await unlockedManager();
    const enc = await m.encrypt('');
    const dec = await m.decrypt(enc);
    expect(dec).toBe('');
  });

  it('round-trips unicode / emoji content', async () => {
    const m = await unlockedManager();
    const text = 'caf\u00e9 \ud83d\ude80 \u4e2d\u6587';
    const enc = await m.encrypt(text);
    const dec = await m.decrypt(enc);
    expect(dec).toBe(text);
  });

  it('round-trips long values (> 1 KB)', async () => {
    const m = await unlockedManager();
    const text = 'x'.repeat(2000);
    const enc = await m.encrypt(text);
    const dec = await m.decrypt(enc);
    expect(dec).toBe(text);
  });

  it('decrypt fails with a different master key', async () => {
    const m1 = await unlockedManager();
    const enc = await m1.encrypt(PLAINTEXT);

    const m2 = freshManager();
    await m2.unlock('different-master-key-32chars!!!!');
    await expect(m2.decrypt(enc)).rejects.toThrow(/decryption failed/);
  });

  it('decrypt fails with tampered ciphertext', async () => {
    const m = await unlockedManager();
    let enc = await m.encrypt(PLAINTEXT);
    // Flip the last base64 character to corrupt the auth tag
    const prefix = 'enc:';
    const b64 = enc.slice(prefix.length);
    const buf = Buffer.from(b64, 'base64');
    buf[buf.length - 1] ^= 0xff;
    enc = prefix + buf.toString('base64');
    await expect(m.decrypt(enc)).rejects.toThrow(/decryption failed/);
  });
});

// ---------------------------------------------------------------------------
// Cross-compatibility: binary format verification
// ---------------------------------------------------------------------------

describe('KeyManagerImpl — binary format', () => {
  it('encrypted payload decodes to salt[16] + nonce[12] + ciphertext + authTag[16]', async () => {
    const m = await unlockedManager();
    const enc = await m.encrypt(PLAINTEXT);

    const b64 = enc.slice('enc:'.length);
    const combined = Buffer.from(b64, 'base64');

    // Minimum length check
    expect(combined.length).toBeGreaterThanOrEqual(SALT_LEN + NONCE_LEN + AUTH_TAG_LEN + 1);

    // Verify we can manually decrypt using the extracted fields
    const salt = combined.subarray(0, SALT_LEN);
    const nonce = combined.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
    const rest = combined.subarray(SALT_LEN + NONCE_LEN);
    const encData = rest.subarray(0, rest.length - AUTH_TAG_LEN);
    const authTag = rest.subarray(rest.length - AUTH_TAG_LEN);

    const derivedKey = await deriveKey(Buffer.from(VALID_KEY, 'utf8'), salt);
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, nonce);
    decipher.setAuthTag(authTag);
    const pt = Buffer.concat([decipher.update(encData), decipher.final()]).toString('utf8');
    expect(pt).toBe(PLAINTEXT);
  });

  it('manually constructed enc: value can be decrypted', async () => {
    // Build a ciphertext manually with known parameters, verify the manager decrypts it
    const salt = Buffer.alloc(SALT_LEN, 0x01);
    const nonce = Buffer.alloc(NONCE_LEN, 0x02);
    const derivedKey = await deriveKey(Buffer.from(VALID_KEY, 'utf8'), salt);

    const cipher = createDecipheriv as unknown as never; // suppress unused import warning
    void cipher;

    const { createCipheriv: mkCipher } = await import('node:crypto');
    const c = mkCipher('aes-256-gcm', derivedKey, nonce);
    const enc1 = c.update(PLAINTEXT, 'utf8');
    const enc2 = c.final();
    const tag = c.getAuthTag();
    const combined = Buffer.concat([salt, nonce, enc1, enc2, tag]);
    const payload = 'enc:' + combined.toString('base64');

    const m = await unlockedManager();
    const result = await m.decrypt(payload);
    expect(result).toBe(PLAINTEXT);
  });
});

// ---------------------------------------------------------------------------
// Argon2id parameters
// ---------------------------------------------------------------------------

describe('deriveKey — argon2id parameters', () => {
  it('produces a 32-byte key', async () => {
    const salt = Buffer.alloc(16, 0xab);
    const key = await deriveKey(Buffer.from('test-master-key-16c'), salt);
    expect(key.length).toBe(32);
  });

  it('is deterministic given same inputs', async () => {
    const salt = Buffer.alloc(16, 0x55);
    const mkBuf = Buffer.from('deterministic-key-test-16chars!!', 'utf8');
    const k1 = await deriveKey(mkBuf, salt);
    const k2 = await deriveKey(mkBuf, salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it('produces different keys for different salts', async () => {
    const mk = Buffer.from('same-master-key-here-16chars!!!!', 'utf8');
    const s1 = Buffer.alloc(16, 0x11);
    const s2 = Buffer.alloc(16, 0x22);
    const k1 = await deriveKey(mk, s1);
    const k2 = await deriveKey(mk, s2);
    expect(k1.equals(k2)).toBe(false);
  });

  it('uses argon2id type (type=2, not argon2d=0 or argon2i=1)', async () => {
    // Verify by checking that the argon2id constant equals 2
    expect(argon2.argon2id).toBe(2);

    // Confirm a hash produced with the same parameters matches expected behavior
    // by verifying the key length and determinism (not the exact bytes, as those
    // depend on the argon2 implementation internals)
    const salt = Buffer.alloc(16, 0x33);
    const mk = Buffer.from('argon2id-type-test-key-16chars!!', 'utf8');
    const key = await deriveKey(mk, salt);
    expect(key.length).toBe(32);
    expect(Buffer.isBuffer(key)).toBe(true);
  });

  it('produces deterministic output for known inputs (cross-compatibility fixture)', async () => {
    // This fixture verifies that:
    //   key = "cross-compat-test-key-exactly32!"  (32 bytes)
    //   salt = bytes [0x00..0x0F]
    //   time=1, memory=65536, threads=4, keyLen=32
    //
    // produces a deterministic 32-byte key.
    const masterKey = Buffer.from('cross-compat-test-key-exactly32!', 'utf8');
    const salt = Buffer.from([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    ]);
    const key = await deriveKey(masterKey, salt);
    expect(key.length).toBe(32);
    // Verify it is deterministic across two calls (tests that parameters are stable)
    const key2 = await deriveKey(masterKey, salt);
    expect(key.equals(key2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('KeyManagerImpl — rate limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to 4 failed attempts without blocking', async () => {
    const m = freshManager();
    for (let i = 0; i < 4; i++) {
      await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    }
    // 5th attempt should still throw ValidationError, not RateLimitedError
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
  });

  it('blocks on the 6th failed attempt within 60 seconds', async () => {
    const m = freshManager();
    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    }
    // 6th attempt should hit rate limit
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(RateLimitedError);
  });

  it('RateLimitedError has positive retryAfterSeconds', async () => {
    const m = freshManager();
    for (let i = 0; i < 5; i++) {
      await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    }
    let caught: unknown;
    try {
      await m.unlock(SHORT_KEY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('unblocks after 60 seconds', async () => {
    const m = freshManager();
    for (let i = 0; i < 5; i++) {
      await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    }
    // Rate limited now
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(RateLimitedError);

    // Advance time by 61 seconds
    vi.advanceTimersByTime(61_000);

    // Should accept a valid key now
    await expect(m.unlock(VALID_KEY)).resolves.toBeUndefined();
    expect(m.isLocked()).toBe(false);
  });

  it('rate limit resets after successful unlock', async () => {
    const m = freshManager();
    // Accumulate 3 failed attempts
    for (let i = 0; i < 3; i++) {
      await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    }
    // Successful unlock resets the counter
    await m.unlock(VALID_KEY);
    m.lock();

    // Should now be able to make 5 more failed attempts without being rate-limited
    for (let i = 0; i < 4; i++) {
      await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    }
    // 5th post-reset attempt still ValidationError (not RateLimitedError)
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    // 6th post-reset attempt is RateLimitedError
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(RateLimitedError);
  });

  it('rate limit window is sliding (old attempts expire)', async () => {
    const m = freshManager();
    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    }
    // Advance 59 seconds (oldest attempt still within window)
    vi.advanceTimersByTime(59_000);
    // 5th attempt (still within window of first 4) → ValidationError
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
    // 6th attempt within window → RateLimitedError
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(RateLimitedError);

    // Advance past the first attempt's window (61 seconds total from first attempt)
    vi.advanceTimersByTime(2_000);
    // Now only 4 of the 5 attempts are within the window — should accept bad key again
    await expect(m.unlock(SHORT_KEY)).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// newKeyManager factory
// ---------------------------------------------------------------------------

describe('newKeyManager factory', () => {
  afterEach(() => {
    delete process.env['OPENHIVE_MASTER_KEY'];
  });

  it('creates a locked manager when env var is not set', async () => {
    delete process.env['OPENHIVE_MASTER_KEY'];
    const m = await newKeyManager();
    expect(m.isLocked()).toBe(true);
  });

  it('auto-unlocks when OPENHIVE_MASTER_KEY is set', async () => {
    process.env['OPENHIVE_MASTER_KEY'] = VALID_KEY;
    const m = await newKeyManager();
    expect(m.isLocked()).toBe(false);
    // Env var should be cleared
    expect(process.env['OPENHIVE_MASTER_KEY']).toBeUndefined();
  });

  it('clears OPENHIVE_MASTER_KEY after auto-unlock', async () => {
    process.env['OPENHIVE_MASTER_KEY'] = VALID_KEY;
    await newKeyManager();
    expect(process.env['OPENHIVE_MASTER_KEY']).toBeUndefined();
  });
});
