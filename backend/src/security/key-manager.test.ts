import { describe, it, expect, beforeEach } from 'vitest';
import { KeyManagerImpl } from './key-manager.js';
import { EncryptionLockedError, ValidationError } from '../domain/index.js';

const MASTER_KEY = 'test-master-key-that-is-at-least-32-chars-long!!';
const OTHER_MASTER_KEY = 'another-master-key-also-at-least-32-chars-long!!';

describe('KeyManagerImpl', () => {
  let km: KeyManagerImpl;

  beforeEach(async () => {
    km = new KeyManagerImpl();
  });

  describe('isUnlocked', () => {
    it('returns false initially', () => {
      expect(km.isUnlocked()).toBe(false);
    });

    it('returns true after unlock', async () => {
      await km.unlock(MASTER_KEY);
      expect(km.isUnlocked()).toBe(true);
    });

    it('returns false after lock', async () => {
      await km.unlock(MASTER_KEY);
      await km.lock();
      expect(km.isUnlocked()).toBe(false);
    });
  });

  describe('unlock / lock cycle', () => {
    it('unlock -> lock -> unlock works correctly', async () => {
      await km.unlock(MASTER_KEY);
      expect(km.isUnlocked()).toBe(true);

      await km.lock();
      expect(km.isUnlocked()).toBe(false);

      await km.unlock(MASTER_KEY);
      expect(km.isUnlocked()).toBe(true);

      // Verify encryption still works after re-unlock
      const ct = await km.encrypt('hello');
      const pt = await km.decrypt(ct);
      expect(pt).toBe('hello');
    });
  });

  describe('encrypt / decrypt', () => {
    beforeEach(async () => {
      await km.unlock(MASTER_KEY);
    });

    it('round-trips plaintext correctly', async () => {
      const plaintext = 'secret-api-key-12345';
      const ciphertext = await km.encrypt(plaintext);
      const decrypted = await km.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('round-trips empty string', async () => {
      const ct = await km.encrypt('');
      const pt = await km.decrypt(ct);
      expect(pt).toBe('');
    });

    it('round-trips unicode text', async () => {
      const plaintext = 'こんにちは世界 🌍';
      const ct = await km.encrypt(plaintext);
      const pt = await km.decrypt(ct);
      expect(pt).toBe(plaintext);
    });

    it('produces base64(iv):base64(payload) format', async () => {
      const ct = await km.encrypt('test');
      const parts = ct.split(':');
      expect(parts).toHaveLength(2);
      // IV should be 12 bytes = 16 base64 chars
      const iv = Buffer.from(parts[0], 'base64');
      expect(iv.length).toBe(12);
    });

    it('produces different ciphertexts for same plaintext (unique IV)', async () => {
      const ct1 = await km.encrypt('same-plaintext');
      const ct2 = await km.encrypt('same-plaintext');
      expect(ct1).not.toBe(ct2);
      // Both should decrypt to the same value
      expect(await km.decrypt(ct1)).toBe('same-plaintext');
      expect(await km.decrypt(ct2)).toBe('same-plaintext');
    });
  });

  describe('locked state guards', () => {
    it('encrypt throws EncryptionLockedError when locked', async () => {
      await expect(km.encrypt('test')).rejects.toThrow(EncryptionLockedError);
    });

    it('decrypt throws EncryptionLockedError when locked', async () => {
      await expect(km.decrypt('aaa:bbb')).rejects.toThrow(EncryptionLockedError);
    });

    it('encrypt throws after lock()', async () => {
      await km.unlock(MASTER_KEY);
      await km.lock();
      await expect(km.encrypt('test')).rejects.toThrow(EncryptionLockedError);
    });

    it('decrypt throws after lock()', async () => {
      await km.unlock(MASTER_KEY);
      const ct = await km.encrypt('test');
      await km.lock();
      await expect(km.decrypt(ct)).rejects.toThrow(EncryptionLockedError);
    });
  });

  describe('tampered ciphertext', () => {
    it('throws ValidationError when ciphertext is modified', async () => {
      await km.unlock(MASTER_KEY);
      const ct = await km.encrypt('secret');
      const parts = ct.split(':');
      // Tamper with the payload: flip a byte
      const payload = Buffer.from(parts[1], 'base64');
      payload[0] ^= 0xff;
      const tampered = `${parts[0]}:${payload.toString('base64')}`;
      await expect(km.decrypt(tampered)).rejects.toThrow(ValidationError);
      await expect(km.decrypt(tampered)).rejects.toThrow(/tampered or wrong key/);
    });

    it('throws ValidationError for invalid format (no colon)', async () => {
      await km.unlock(MASTER_KEY);
      await expect(km.decrypt('no-colon-here')).rejects.toThrow(ValidationError);
      await expect(km.decrypt('no-colon-here')).rejects.toThrow(/invalid ciphertext format/);
    });
  });

  describe('rekey', () => {
    it('throws EncryptionLockedError when locked', async () => {
      await expect(km.rekey(OTHER_MASTER_KEY)).rejects.toThrow(EncryptionLockedError);
    });

    it('allows decrypt with new key after rekey', async () => {
      await km.unlock(MASTER_KEY);
      const ct = await km.encrypt('before-rekey');
      // Rekey changes the derived key
      await km.rekey(OTHER_MASTER_KEY);
      // Old ciphertext encrypted with old key should fail
      await expect(km.decrypt(ct)).rejects.toThrow(ValidationError);
      // New encryption with new key should round-trip
      const ct2 = await km.encrypt('after-rekey');
      const pt2 = await km.decrypt(ct2);
      expect(pt2).toBe('after-rekey');
    });

    it('maintains unlocked state after rekey', async () => {
      await km.unlock(MASTER_KEY);
      await km.rekey(OTHER_MASTER_KEY);
      expect(km.isUnlocked()).toBe(true);
    });
  });

  describe('deterministic key derivation', () => {
    it('same master key produces same derived key (can decrypt across instances)', async () => {
      const km1 = new KeyManagerImpl();
      const km2 = new KeyManagerImpl();
      await km1.unlock(MASTER_KEY);
      await km2.unlock(MASTER_KEY);
      const ct = await km1.encrypt('cross-instance');
      const pt = await km2.decrypt(ct);
      expect(pt).toBe('cross-instance');
    });

    it('different master keys produce different derived keys', async () => {
      const km1 = new KeyManagerImpl();
      const km2 = new KeyManagerImpl();
      await km1.unlock(MASTER_KEY);
      await km2.unlock(OTHER_MASTER_KEY);
      const ct = await km1.encrypt('wrong-key-test');
      await expect(km2.decrypt(ct)).rejects.toThrow(ValidationError);
    });
  });
});
