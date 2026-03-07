/**
 * OpenHive Backend - KeyManager Implementation
 *
 * Implements AES-256-GCM encryption with Argon2id key derivation.
 *
 * Wire format: "enc:" + base64(salt[16] || nonce[12] || ciphertext || authTag[16])
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { EncryptionLockedError, RateLimitedError, ValidationError } from '../domain/errors.js';
import type { KeyManager } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARGON2_TIME_COST = 1;
const ARGON2_MEMORY_COST = 64 * 1024; // 65536 KB
const ARGON2_PARALLELISM = 4;
const ARGON2_HASH_LENGTH = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16; // AES-256-GCM always produces a 16-byte tag
const ENC_PREFIX = 'enc:';
const MIN_KEY_LEN = 16;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// KeyManager implementation
// ---------------------------------------------------------------------------

/**
 * Manages master key lifecycle and provides AES-256-GCM encrypt/decrypt
 * with Argon2id key derivation. Thread safety note: Node.js is single-
 * threaded — no mutex needed, but async operations must not interleave
 * state reads, so masterKey is copied before any async call.
 */
export class KeyManagerImpl implements KeyManager {
  private masterKey: Buffer | null = null;
  private locked: boolean = true;
  private attempts: Date[] = [];

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  /**
   * Returns true if no master key is currently loaded.
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Loads the master key and transitions to unlocked state.
   *
   * Enforces:
   *   - Rate limit: at most 5 attempts within a 60-second window
   *   - Minimum key length: 16 characters
   *
   * On success: clears OPENHIVE_MASTER_KEY env var, resets rate limiter.
   * On validation failure: records the attempt against the rate limit.
   */
  async unlock(masterKey: string): Promise<void> {
    this.checkRateLimit();

    if (masterKey.length < MIN_KEY_LEN) {
      this.recordAttempt();
      throw new ValidationError(
        'master_key',
        `master key must be at least ${MIN_KEY_LEN} characters`,
      );
    }

    this.masterKey = Buffer.from(masterKey, 'utf8');
    this.locked = false;

    // Clear the key from the environment so it doesn't persist
    delete process.env['OPENHIVE_MASTER_KEY'];

    // Reset rate limiter on successful unlock
    this.attempts = [];
  }

  /**
   * Clears the master key and transitions to locked state.
   */
  lock(): void {
    this.masterKey = null;
    this.locked = true;
  }

  /**
   * Encrypts plaintext using AES-256-GCM with a fresh Argon2id-derived key.
   *
   * Returns: "enc:" + base64(salt[16] || nonce[12] || ciphertext || authTag[16])
   *
   * Throws EncryptionLockedError if the key manager is locked.
   */
  async encrypt(plaintext: string): Promise<string> {
    if (this.locked || this.masterKey === null) {
      throw new EncryptionLockedError();
    }

    // Copy master key before async operations — avoids a lock() race
    const keyMaterial = Buffer.from(this.masterKey);

    const salt = randomBytes(SALT_LEN);
    const nonce = randomBytes(NONCE_LEN);
    const derivedKey = await deriveKey(keyMaterial, salt);

    const cipher = createCipheriv('aes-256-gcm', derivedKey, nonce);
    const ct1 = cipher.update(plaintext, 'utf8');
    const ct2 = cipher.final();
    const authTag = cipher.getAuthTag(); // 16 bytes

    // Layout: salt || nonce || ciphertext || authTag
    const combined = Buffer.concat([salt, nonce, ct1, ct2, authTag]);
    return ENC_PREFIX + combined.toString('base64');
  }

  /**
   * Decrypts a value produced by encrypt().
   *
   * Expects: "enc:" + base64(salt[16] || nonce[12] || ciphertext || authTag[16])
   *
   * Throws EncryptionLockedError if the key manager is locked.
   * Throws Error on format errors or authentication failures.
   */
  async decrypt(ciphertext: string): Promise<string> {
    if (this.locked || this.masterKey === null) {
      throw new EncryptionLockedError();
    }

    // Copy master key before async operations
    const keyMaterial = Buffer.from(this.masterKey);

    if (!ciphertext.startsWith(ENC_PREFIX)) {
      throw new Error(`ciphertext missing ${ENC_PREFIX} prefix`);
    }

    const encoded = ciphertext.slice(ENC_PREFIX.length);
    const combined = Buffer.from(encoded, 'base64');

    // Minimum: salt(16) + nonce(12) + authTag(16).
    // Empty plaintext is valid — the auth tag is always present even with 0 bytes of ciphertext.
    // Empty plaintext is valid — the auth tag is always present even with 0 bytes of ciphertext.
    const minLen = SALT_LEN + NONCE_LEN + AUTH_TAG_LEN;
    if (combined.length < minLen) {
      throw new Error('ciphertext too short');
    }

    const salt = combined.subarray(0, SALT_LEN);
    const nonce = combined.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
    // The rest is ciphertext || authTag — auth tag is the last 16 bytes
    const encWithTag = combined.subarray(SALT_LEN + NONCE_LEN);
    const encData = encWithTag.subarray(0, encWithTag.length - AUTH_TAG_LEN);
    const authTag = encWithTag.subarray(encWithTag.length - AUTH_TAG_LEN);

    const derivedKey = await deriveKey(keyMaterial, salt);

    const decipher = createDecipheriv('aes-256-gcm', derivedKey, nonce);
    decipher.setAuthTag(authTag);

    let plaintext: string;
    try {
      const pt1 = decipher.update(encData);
      const pt2 = decipher.final();
      plaintext = Buffer.concat([pt1, pt2]).toString('utf8');
    } catch {
      throw new Error('decryption failed: authentication tag mismatch or corrupted data');
    }

    return plaintext;
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  /**
   * Prunes expired attempts and throws RateLimitedError if the sliding-window
   * limit has been reached.
   */
  private checkRateLimit(): void {
    const now = new Date();
    const cutoff = now.getTime() - RATE_LIMIT_WINDOW_MS;

    // Prune expired attempts
    this.attempts = this.attempts.filter((t) => t.getTime() > cutoff);

    if (this.attempts.length >= MAX_ATTEMPTS) {
      // Retry-after = time until the oldest attempt expires
      const oldest = this.attempts[0];
      const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now.getTime() - oldest.getTime());
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      throw new RateLimitedError(retryAfterSeconds);
    }
  }

  /**
   * Records a failed unlock attempt timestamp.
   */
  private recordAttempt(): void {
    this.attempts.push(new Date());
  }
}

// ---------------------------------------------------------------------------
// Key derivation — exported for testing the exact parameters
// ---------------------------------------------------------------------------

/**
 * Derives a 32-byte AES key from a master key and salt using Argon2id.
 *
 * Parameters: time=1, memory=64*1024, parallelism=4, hashLength=32.
 */
export async function deriveKey(masterKey: Buffer, salt: Buffer): Promise<Buffer> {
  return argon2.hash(masterKey, {
    type: argon2.argon2id,
    timeCost: ARGON2_TIME_COST,
    memoryCost: ARGON2_MEMORY_COST,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    salt,
    raw: true,
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new KeyManager in locked state.
 * If OPENHIVE_MASTER_KEY is set in the environment, unlocks automatically.
 */
export async function newKeyManager(): Promise<KeyManagerImpl> {
  const manager = new KeyManagerImpl();
  const envKey = process.env['OPENHIVE_MASTER_KEY'];
  if (envKey !== undefined && envKey !== '') {
    await manager.unlock(envKey);
  }
  return manager;
}
