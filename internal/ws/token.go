package ws

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
)

const tokenBytes = 32

// TokenManager generates and validates one-time tokens for WebSocket authentication.
// Tokens are stored in-memory only and consumed on first use.
type TokenManager struct {
	// tokens maps token string -> team ID
	tokens map[string]string
	mu     sync.Mutex
}

// NewTokenManager creates a new TokenManager.
func NewTokenManager() *TokenManager {
	return &TokenManager{
		tokens: make(map[string]string),
	}
}

// GenerateToken creates a cryptographically random one-time token associated
// with the given team ID. The token is 32 bytes, hex encoded (64 chars).
func (tm *TokenManager) GenerateToken(teamID string) (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}

	token := hex.EncodeToString(b)

	tm.mu.Lock()
	tm.tokens[token] = teamID
	tm.mu.Unlock()

	return token, nil
}

// ValidateAndConsume atomically checks if a token is valid and removes it.
// Returns the team ID and true if valid, or empty string and false if invalid/consumed.
func (tm *TokenManager) ValidateAndConsume(token string) (string, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	teamID, ok := tm.tokens[token]
	if !ok {
		return "", false
	}

	delete(tm.tokens, token)
	return teamID, true
}

// Validate checks if a token is valid without consuming it.
// Returns the team ID and true if valid.
func (tm *TokenManager) Validate(token string) (string, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	teamID, ok := tm.tokens[token]
	return teamID, ok
}

// Consume removes a previously validated token. Returns false if already consumed.
func (tm *TokenManager) Consume(token string) bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	if _, ok := tm.tokens[token]; !ok {
		return false
	}
	delete(tm.tokens, token)
	return true
}

// PendingCount returns the number of unused tokens. Useful for testing.
func (tm *TokenManager) PendingCount() int {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return len(tm.tokens)
}
