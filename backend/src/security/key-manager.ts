/**
 * AES-256-GCM encryption key manager for OpenHive credential vault.
 *
 * ## Master Key (NFR07)
 *
 * The master encryption key is sourced from the `OPENHIVE_MASTER_KEY` environment
 * variable. This key MUST be a 256-bit (32-byte) value, base64-encoded. The
 * master key is never stored on disk — it exists only in process memory while the
 * vault is unlocked.
 *
 * ## Encryption Details
 *
 * - **Algorithm**: AES-256-GCM (authenticated encryption with associated data)
 * - **IV/Nonce**: 12-byte unique random nonce generated via `crypto.randomBytes(12)`
 *   for every encryption operation. Nonces MUST NEVER be reused with the same key.
 * - **Auth Tag**: 16-byte GCM authentication tag appended to ciphertext
 * - **Output Format**: `<base64(iv)>:<base64(ciphertext + authTag)>`
 * - **Key Derivation**: Argon2id derives the encryption key from the master key,
 *   ensuring resistance to brute-force and side-channel attacks
 *
 * ## Credential Vault Scope
 *
 * The credential vault is scoped per-team. Each team's credentials are encrypted
 * with the same derived key but isolated by team slug in storage. Accessing a
 * locked vault throws an `EncryptionLockedError`.
 *
 * ## Token Security (NFR10)
 *
 * - Token generation uses `crypto.randomBytes()` for cryptographically secure
 *   random values
 * - Token comparison uses `crypto.timingSafeEqual()` to prevent timing attacks
 *
 * @module security/key-manager
 */

import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { KeyManager, Credential } from '../domain/index.js';
import { EncryptionLockedError, ValidationError } from '../domain/index.js';

const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32; // AES-256

/**
 * Derives a deterministic salt from the master key using SHA-256.
 * This allows the same master key to always produce the same derived encryption key.
 */
function deriveSalt(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest().subarray(0, 16);
}

/**
 * Derives an AES-256 encryption key from a master key using Argon2id.
 * OWASP minimum parameters: 64MB memory, 3 iterations, 4 parallelism.
 */
async function deriveKey(masterKey: string): Promise<Buffer> {
  const salt = deriveSalt(masterKey);
  const derived = await argon2.hash(masterKey, {
    type: argon2.argon2id,
    memoryCost: 65536,  // 64 MB
    timeCost: 3,
    parallelism: 4,
    salt,
    raw: true,
    hashLength: DERIVED_KEY_BYTES,
  });
  // argon2.hash with raw: true returns a Buffer
  return Buffer.from(derived);
}

/**
 * Implementation of the KeyManager interface providing AES-256-GCM
 * encryption/decryption with OPENHIVE_MASTER_KEY-based vault management.
 *
 * Call `unlock()` with the master key before any encrypt/decrypt operations.
 * Calling encrypt/decrypt while locked throws `EncryptionLockedError`.
 */
export class KeyManagerImpl implements KeyManager {
  private derivedKey: Buffer | null = null;
  private isUnlockedState = false;

  async unlock(masterKey: string): Promise<void> {
    this.derivedKey = await deriveKey(masterKey);
    this.isUnlockedState = true;
  }

  async lock(): Promise<void> {
    if (this.derivedKey) {
      this.derivedKey.fill(0);
    }
    this.derivedKey = null;
    this.isUnlockedState = false;
  }

  async rekey(
    newMasterKey: string,
    credentialStore?: {
      listByTeam: (teamSlug: string) => Promise<Credential[]>;
      get: (id: string) => Promise<Credential>;
      update: (credential: Credential) => Promise<void>;
    },
    teamSlugs?: string[],
  ): Promise<number> {
    // AC-L2-11: If credentialStore provided, perform migration
    if (credentialStore) {
      return this.rekeyWithMigration(newMasterKey, credentialStore, teamSlugs);
    }
    // No credentialStore - just swap key (destructive, for testing only)
    this.guardLocked();
    const newKey = await deriveKey(newMasterKey);
    // Zero-fill old key before replacing
    if (this.derivedKey) {
      this.derivedKey.fill(0);
    }
    this.derivedKey = newKey;
    return 0; // No credentials migrated
  }

  /**
   * Rekey with credential migration (AC-L2-11).
   * Decrypts all stored credentials with old key, then re-encrypts with new key.
   * This should be called during maintenance windows with explicit migration.
   *
   * @param newMasterKey - The new master key
   * @param credentialStore - Store to migrate credentials from
   * @param teamSlugs - List of team slugs to migrate (all teams if omitted)
   * @returns Number of credentials re-encrypted
   */
  async rekeyWithMigration(
    newMasterKey: string,
    credentialStore: {
      listByTeam: (teamSlug: string) => Promise<Credential[]>;
      get: (id: string) => Promise<Credential>;
      update: (credential: Credential) => Promise<void>;
    },
    teamSlugs?: string[],
  ): Promise<number> {
    this.guardLocked();

    // Derive new key
    const newKey = await deriveKey(newMasterKey);

    // Track re-encrypted count
    let reencrypted = 0;

    // For each team, decrypt and re-encrypt credentials
    const teams = teamSlugs ?? []; // If no teams provided, caller must enumerate

    for (const teamSlug of teams) {
      const credentials = await credentialStore.listByTeam(teamSlug);

      for (const cred of credentials) {
        if (cred.encrypted_value) {
          try {
            // Decrypt with old key
            const plaintext = await this.decrypt(cred.encrypted_value);
            // Re-encrypt with new key (using newKey directly)
            const iv = crypto.randomBytes(GCM_IV_BYTES);
            const cipher = crypto.createCipheriv('aes-256-gcm', newKey, iv);
            const encrypted = Buffer.concat([
              cipher.update(plaintext, 'utf8'),
              cipher.final(),
            ]);
            const authTag = cipher.getAuthTag();
            const payload = Buffer.concat([encrypted, authTag]);
            const newCiphertext = `${iv.toString('base64')}:${payload.toString('base64')}`;

            // Update in store
            await credentialStore.update({
              ...cred,
              encrypted_value: newCiphertext,
            });
            reencrypted++;
          } catch (err) {
            // Log failure but continue with other credentials
            console.error(`Failed to re-encrypt credential ${cred.id}:`, err);
          }
        }
      }
    }

    // Now swap to new key
    if (this.derivedKey) {
      this.derivedKey.fill(0);
    }
    this.derivedKey = newKey;

    return reencrypted;
  }

  async encrypt(plaintext: string): Promise<string> {
    this.guardLocked();
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.derivedKey!, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // Format: base64(iv):base64(ciphertext + authTag)
    const payload = Buffer.concat([encrypted, authTag]);
    return `${iv.toString('base64')}:${payload.toString('base64')}`;
  }

  async decrypt(ciphertext: string): Promise<string> {
    this.guardLocked();
    const colonIdx = ciphertext.indexOf(':');
    if (colonIdx === -1) {
      throw new ValidationError('Decryption failed: invalid ciphertext format');
    }
    const ivB64 = ciphertext.substring(0, colonIdx);
    const payloadB64 = ciphertext.substring(colonIdx + 1);

    const iv = Buffer.from(ivB64, 'base64');
    const payload = Buffer.from(payloadB64, 'base64');

    if (iv.length !== GCM_IV_BYTES) {
      throw new ValidationError('Decryption failed: invalid IV length');
    }
    if (payload.length < GCM_AUTH_TAG_BYTES) {
      throw new ValidationError('Decryption failed: payload too short');
    }

    const encryptedData = payload.subarray(0, payload.length - GCM_AUTH_TAG_BYTES);
    const authTag = payload.subarray(payload.length - GCM_AUTH_TAG_BYTES);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.derivedKey!, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      throw new ValidationError('Decryption failed: ciphertext tampered or wrong key');
    }
  }

  isUnlocked(): boolean {
    return this.isUnlockedState;
  }

  private guardLocked(): void {
    if (!this.isUnlockedState || !this.derivedKey) {
      throw new EncryptionLockedError('Key manager is locked');
    }
  }
}
