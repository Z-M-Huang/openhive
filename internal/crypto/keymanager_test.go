package crypto

import (
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testMasterKey = "this-is-a-test-master-key-32chars!"

func TestNewManager_StartsLocked(t *testing.T) {
	m := NewManager()
	assert.True(t, m.IsLocked())
}

func TestManager_UnlockAndLock(t *testing.T) {
	m := NewManager()

	err := m.Unlock(testMasterKey)
	require.NoError(t, err)
	assert.False(t, m.IsLocked())

	m.Lock()
	assert.True(t, m.IsLocked())
}

func TestManager_EncryptDecryptRoundTrip(t *testing.T) {
	m := NewManager()
	require.NoError(t, m.Unlock(testMasterKey))

	plaintext := "my-secret-value-12345"
	encrypted, err := m.Encrypt(plaintext)
	require.NoError(t, err)
	assert.True(t, len(encrypted) > 0)
	assert.Contains(t, encrypted, "enc:")

	decrypted, err := m.Decrypt(encrypted)
	require.NoError(t, err)
	assert.Equal(t, plaintext, decrypted)
}

func TestManager_EncryptWhenLocked(t *testing.T) {
	m := NewManager()
	_, err := m.Encrypt("test")
	assert.Error(t, err)
	var ele *domain.EncryptionLockedError
	assert.True(t, errors.As(err, &ele))
}

func TestManager_DecryptWhenLocked(t *testing.T) {
	m := NewManager()
	_, err := m.Decrypt("enc:test")
	assert.Error(t, err)
	var ele *domain.EncryptionLockedError
	assert.True(t, errors.As(err, &ele))
}

func TestManager_DecryptCorrupted(t *testing.T) {
	m := NewManager()
	require.NoError(t, m.Unlock(testMasterKey))

	// Missing prefix
	_, err := m.Decrypt("not-encrypted")
	assert.Error(t, err)

	// Bad base64
	_, err = m.Decrypt("enc:not-valid-base64!!!")
	assert.Error(t, err)

	// Too short
	_, err = m.Decrypt("enc:dGVzdA==")
	assert.Error(t, err)

	// Valid base64 but wrong key data
	_, err = m.Decrypt("enc:dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdA==")
	assert.Error(t, err)
}

func TestManager_WrongMasterKey(t *testing.T) {
	m1 := NewManager()
	require.NoError(t, m1.Unlock(testMasterKey))

	encrypted, err := m1.Encrypt("secret-data")
	require.NoError(t, err)

	m2 := NewManager()
	require.NoError(t, m2.Unlock("different-master-key-32chars!!!"))

	_, err = m2.Decrypt(encrypted)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "decryption failed")
}

func TestManager_UnlockKeyTooShort(t *testing.T) {
	m := NewManager()
	err := m.Unlock("short")
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.True(t, errors.As(err, &ve))
	assert.True(t, m.IsLocked())
}

func TestManager_UnlockClearsEnv(t *testing.T) {
	t.Setenv("OPENHIVE_MASTER_KEY", testMasterKey)

	m := NewManager()
	require.NoError(t, m.Unlock(testMasterKey))

	// Env var should be cleared
	assert.Empty(t, os.Getenv("OPENHIVE_MASTER_KEY"))
}

func TestManager_RateLimiting(t *testing.T) {
	m := NewManager()

	// Make 5 failed attempts (key too short)
	for i := 0; i < 5; i++ {
		_ = m.Unlock("short")
	}

	// 6th attempt should be rate limited
	err := m.Unlock(testMasterKey)
	assert.Error(t, err)
	var rle *domain.RateLimitedError
	assert.True(t, errors.As(err, &rle))
}

func TestManager_SuccessfulUnlockResetsRateLimit(t *testing.T) {
	m := NewManager()

	// Make 4 failed attempts
	for i := 0; i < 4; i++ {
		_ = m.Unlock("short")
	}

	// Successful unlock
	require.NoError(t, m.Unlock(testMasterKey))

	// Should be able to make more attempts now
	m.Lock()
	for i := 0; i < 4; i++ {
		_ = m.Unlock("short")
	}
	// 5th attempt after reset should still work
	err := m.Unlock(testMasterKey)
	require.NoError(t, err)
}

func TestManager_ConcurrentEncryptDecrypt(t *testing.T) {
	m := NewManager()
	require.NoError(t, m.Unlock(testMasterKey))

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			encrypted, err := m.Encrypt("concurrent-test-data")
			if err != nil {
				t.Errorf("encrypt failed: %v", err)
				return
			}
			decrypted, err := m.Decrypt(encrypted)
			if err != nil {
				t.Errorf("decrypt failed: %v", err)
				return
			}
			assert.Equal(t, "concurrent-test-data", decrypted)
		}(i)
	}
	wg.Wait()
}

func TestManager_EncryptProducesDifferentCiphertexts(t *testing.T) {
	m := NewManager()
	require.NoError(t, m.Unlock(testMasterKey))

	enc1, err := m.Encrypt("same-plaintext")
	require.NoError(t, err)
	enc2, err := m.Encrypt("same-plaintext")
	require.NoError(t, err)

	// Different random salt/nonce means different ciphertext
	assert.NotEqual(t, enc1, enc2)

	// Both should decrypt to the same value
	dec1, err := m.Decrypt(enc1)
	require.NoError(t, err)
	dec2, err := m.Decrypt(enc2)
	require.NoError(t, err)
	assert.Equal(t, dec1, dec2)
}
