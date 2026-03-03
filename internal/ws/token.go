package ws

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

const (
	tokenBytes  = 32
	tokenTTL    = 5 * time.Minute
	cleanupTick = 60 * time.Second
)

// tokenEntry holds a token along with its creation time for TTL enforcement.
type tokenEntry struct {
	teamID    string
	createdAt time.Time
}

// TokenManager generates and validates one-time tokens for WebSocket authentication.
// Tokens are stored in-memory only and consumed on first use.
// Tokens expire after 5 minutes even if not consumed.
type TokenManager struct {
	// tokens maps token string -> tokenEntry
	tokens map[string]tokenEntry
	mu     sync.Mutex
	stopCh chan struct{}
	once   sync.Once
}

// NewTokenManager creates a new TokenManager and starts the background cleanup goroutine.
func NewTokenManager() *TokenManager {
	tm := &TokenManager{
		tokens: make(map[string]tokenEntry),
		stopCh: make(chan struct{}),
	}
	tm.once.Do(func() {
		go tm.cleanupLoop()
	})
	return tm
}

// GenerateToken creates a cryptographically random one-time token associated
// with the given team ID. The token is 32 bytes, hex encoded (64 chars).
// Tokens expire after 5 minutes.
func (tm *TokenManager) GenerateToken(teamID string) (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}

	token := hex.EncodeToString(b)

	tm.mu.Lock()
	tm.tokens[token] = tokenEntry{teamID: teamID, createdAt: time.Now()}
	tm.mu.Unlock()

	return token, nil
}

// ValidateAndConsume atomically checks if a token is valid and removes it.
// Returns the team ID and true if valid, or empty string and false if invalid/consumed/expired.
func (tm *TokenManager) ValidateAndConsume(token string) (string, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	entry, ok := tm.tokens[token]
	if !ok {
		return "", false
	}

	if time.Since(entry.createdAt) > tokenTTL {
		delete(tm.tokens, token)
		return "", false
	}

	delete(tm.tokens, token)
	return entry.teamID, true
}

// Validate checks if a token is valid without consuming it.
// Returns the team ID and true if valid and not expired.
func (tm *TokenManager) Validate(token string) (string, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	entry, ok := tm.tokens[token]
	if !ok {
		return "", false
	}

	if time.Since(entry.createdAt) > tokenTTL {
		delete(tm.tokens, token)
		return "", false
	}

	return entry.teamID, true
}

// Consume removes a previously validated token. Returns false if already consumed or expired.
func (tm *TokenManager) Consume(token string) bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	entry, ok := tm.tokens[token]
	if !ok {
		return false
	}

	if time.Since(entry.createdAt) > tokenTTL {
		delete(tm.tokens, token)
		return false
	}

	delete(tm.tokens, token)
	return true
}

// PendingCount returns the number of unexpired, unused tokens. Useful for testing.
func (tm *TokenManager) PendingCount() int {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	now := time.Now()
	count := 0
	for _, entry := range tm.tokens {
		if now.Sub(entry.createdAt) <= tokenTTL {
			count++
		}
	}
	return count
}

// InjectExpiredToken inserts an already-expired token into the manager.
// Used only in tests — do not call from production code.
func (tm *TokenManager) InjectExpiredToken(token, teamID string) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	tm.tokens[token] = tokenEntry{teamID: teamID, createdAt: time.Now().Add(-2 * tokenTTL)}
}

// Close stops the background cleanup goroutine.
func (tm *TokenManager) Close() {
	select {
	case <-tm.stopCh:
		// Already closed
	default:
		close(tm.stopCh)
	}
}

// cleanupLoop periodically removes expired tokens to prevent unbounded growth.
func (tm *TokenManager) cleanupLoop() {
	ticker := time.NewTicker(cleanupTick)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			tm.cleanupExpiredTokens()
		case <-tm.stopCh:
			return
		}
	}
}

// cleanupExpiredTokens removes all tokens older than the TTL.
func (tm *TokenManager) cleanupExpiredTokens() {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	now := time.Now()
	for token, entry := range tm.tokens {
		if now.Sub(entry.createdAt) > tokenTTL {
			delete(tm.tokens, token)
		}
	}
}
