package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"golang.org/x/crypto/argon2"
)

const (
	argon2Time    = 1
	argon2Memory  = 64 * 1024
	argon2Threads = 4
	argon2KeyLen  = 32
	saltLen       = 16
	nonceLen      = 12
	encPrefix     = "enc:"
	minKeyLen     = 16
	maxAttempts   = 5
	rateLimitWindow = time.Minute
)

// Manager implements the domain.KeyManager interface.
type Manager struct {
	masterKey []byte
	locked    bool
	mu        sync.RWMutex

	// Rate limiting
	attempts    []time.Time
	attemptsMu  sync.Mutex
}

// NewManager creates a new KeyManager in a locked state.
func NewManager() *Manager {
	return &Manager{
		locked:   true,
		attempts: make([]time.Time, 0),
	}
}

// IsLocked returns true if the key manager has no master key loaded.
func (m *Manager) IsLocked() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.locked
}

// Unlock loads a master key and transitions to unlocked state.
// It enforces minimum key length (16 chars) and rate limiting (5 attempts/minute).
// After successful unlock, OPENHIVE_MASTER_KEY is cleared from the environment.
func (m *Manager) Unlock(masterKey string) error {
	if err := m.checkRateLimit(); err != nil {
		return err
	}

	if len(masterKey) < minKeyLen {
		m.recordAttempt()
		return &domain.ValidationError{
			Field:   "master_key",
			Message: fmt.Sprintf("master key must be at least %d characters", minKeyLen),
		}
	}

	m.mu.Lock()
	m.masterKey = []byte(masterKey)
	m.locked = false
	m.mu.Unlock()

	// Clear master key from environment
	os.Unsetenv("OPENHIVE_MASTER_KEY")

	// Reset rate limit on successful unlock
	m.attemptsMu.Lock()
	m.attempts = m.attempts[:0]
	m.attemptsMu.Unlock()

	return nil
}

// Lock clears the master key and transitions to locked state.
func (m *Manager) Lock() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.masterKey = nil
	m.locked = true
}

// Encrypt encrypts plaintext using AES-256-GCM with Argon2id key derivation.
// Returns the encrypted value prefixed with "enc:" and base64 encoded.
func (m *Manager) Encrypt(plaintext string) (string, error) {
	m.mu.RLock()
	if m.locked {
		m.mu.RUnlock()
		return "", &domain.EncryptionLockedError{}
	}
	key := make([]byte, len(m.masterKey))
	copy(key, m.masterKey)
	m.mu.RUnlock()

	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("failed to generate salt: %w", err)
	}

	derivedKey := argon2.IDKey(key, salt, argon2Time, argon2Memory, argon2Threads, argon2KeyLen)

	block, err := aes.NewCipher(derivedKey)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}

	ciphertext := gcm.Seal(nil, nonce, []byte(plaintext), nil)

	// Format: enc: + base64(salt || nonce || ciphertext)
	combined := make([]byte, 0, saltLen+nonceLen+len(ciphertext))
	combined = append(combined, salt...)
	combined = append(combined, nonce...)
	combined = append(combined, ciphertext...)

	return encPrefix + base64.StdEncoding.EncodeToString(combined), nil
}

// Decrypt decrypts a value that was encrypted with Encrypt.
func (m *Manager) Decrypt(ciphertext string) (string, error) {
	m.mu.RLock()
	if m.locked {
		m.mu.RUnlock()
		return "", &domain.EncryptionLockedError{}
	}
	key := make([]byte, len(m.masterKey))
	copy(key, m.masterKey)
	m.mu.RUnlock()

	if !strings.HasPrefix(ciphertext, encPrefix) {
		return "", fmt.Errorf("ciphertext missing %s prefix", encPrefix)
	}

	encoded := ciphertext[len(encPrefix):]
	combined, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("failed to decode base64: %w", err)
	}

	if len(combined) < saltLen+nonceLen+1 {
		return "", fmt.Errorf("ciphertext too short")
	}

	salt := combined[:saltLen]
	nonce := combined[saltLen : saltLen+nonceLen]
	encData := combined[saltLen+nonceLen:]

	derivedKey := argon2.IDKey(key, salt, argon2Time, argon2Memory, argon2Threads, argon2KeyLen)

	block, err := aes.NewCipher(derivedKey)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	plaintext, err := gcm.Open(nil, nonce, encData, nil)
	if err != nil {
		return "", fmt.Errorf("decryption failed: %w", err)
	}

	return string(plaintext), nil
}

func (m *Manager) checkRateLimit() error {
	m.attemptsMu.Lock()
	defer m.attemptsMu.Unlock()

	now := time.Now()
	// Remove expired attempts
	valid := m.attempts[:0]
	for _, t := range m.attempts {
		if now.Sub(t) < rateLimitWindow {
			valid = append(valid, t)
		}
	}
	m.attempts = valid

	if len(m.attempts) >= maxAttempts {
		oldest := m.attempts[0]
		retryAfter := int(rateLimitWindow.Seconds() - now.Sub(oldest).Seconds())
		if retryAfter < 1 {
			retryAfter = 1
		}
		return &domain.RateLimitedError{RetryAfterSeconds: retryAfter}
	}

	return nil
}

func (m *Manager) recordAttempt() {
	m.attemptsMu.Lock()
	defer m.attemptsMu.Unlock()
	m.attempts = append(m.attempts, time.Now())
}
