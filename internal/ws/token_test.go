package ws

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokenManager_GenerateToken(t *testing.T) {
	tm := NewTokenManager()
	token, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)

	// 32 bytes = 64 hex chars
	assert.Len(t, token, 64)
}

func TestTokenManager_GenerateTokenUnique(t *testing.T) {
	tm := NewTokenManager()
	tokens := make(map[string]bool)
	for range 100 {
		token, err := tm.GenerateToken("tid-team-001")
		require.NoError(t, err)
		assert.False(t, tokens[token], "token should be unique")
		tokens[token] = true
	}
}

func TestTokenManager_ValidateAndConsume_Valid(t *testing.T) {
	tm := NewTokenManager()
	token, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)

	teamID, ok := tm.ValidateAndConsume(token)
	assert.True(t, ok)
	assert.Equal(t, "tid-team-001", teamID)
}

func TestTokenManager_ValidateAndConsume_Consumed(t *testing.T) {
	tm := NewTokenManager()
	token, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)

	// First consumption succeeds
	teamID, ok := tm.ValidateAndConsume(token)
	assert.True(t, ok)
	assert.Equal(t, "tid-team-001", teamID)

	// Second consumption fails (token already used)
	teamID, ok = tm.ValidateAndConsume(token)
	assert.False(t, ok)
	assert.Empty(t, teamID)
}

func TestTokenManager_ValidateAndConsume_Invalid(t *testing.T) {
	tm := NewTokenManager()
	teamID, ok := tm.ValidateAndConsume("nonexistent-token")
	assert.False(t, ok)
	assert.Empty(t, teamID)
}

func TestTokenManager_PendingCount(t *testing.T) {
	tm := NewTokenManager()
	assert.Equal(t, 0, tm.PendingCount())

	_, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)
	assert.Equal(t, 1, tm.PendingCount())

	_, err = tm.GenerateToken("tid-team-002")
	require.NoError(t, err)
	assert.Equal(t, 2, tm.PendingCount())
}

func TestTokenManager_InMemoryOnly(t *testing.T) {
	// Create a token manager, add tokens, then discard it.
	// A new one should have no tokens.
	tm1 := NewTokenManager()
	_, err := tm1.GenerateToken("tid-team-001")
	require.NoError(t, err)

	tm2 := NewTokenManager()
	assert.Equal(t, 0, tm2.PendingCount())
}

func TestTokenManager_Validate_DoesNotConsume(t *testing.T) {
	tm := NewTokenManager()
	token, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)

	// Validate does not consume — can be called multiple times
	teamID, ok := tm.Validate(token)
	assert.True(t, ok)
	assert.Equal(t, "tid-team-001", teamID)

	teamID, ok = tm.Validate(token)
	assert.True(t, ok)
	assert.Equal(t, "tid-team-001", teamID)

	// Token still pending
	assert.Equal(t, 1, tm.PendingCount())
}

func TestTokenManager_Validate_Invalid(t *testing.T) {
	tm := NewTokenManager()
	teamID, ok := tm.Validate("nonexistent")
	assert.False(t, ok)
	assert.Empty(t, teamID)
}

func TestTokenManager_Consume_AfterValidate(t *testing.T) {
	tm := NewTokenManager()
	token, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)

	// Validate first
	_, ok := tm.Validate(token)
	assert.True(t, ok)

	// Consume removes the token
	ok = tm.Consume(token)
	assert.True(t, ok)
	assert.Equal(t, 0, tm.PendingCount())

	// Second consume fails
	ok = tm.Consume(token)
	assert.False(t, ok)

	// Validate also fails after consume
	_, ok = tm.Validate(token)
	assert.False(t, ok)
}

func TestTokenManager_ConcurrentAccess(t *testing.T) {
	tm := NewTokenManager()
	done := make(chan bool, 20)

	for range 10 {
		go func() {
			_, genErr := tm.GenerateToken("tid-team-001")
			assert.NoError(t, genErr)
			done <- true
		}()
	}

	for range 10 {
		go func() {
			tm.ValidateAndConsume("nonexistent")
			done <- true
		}()
	}

	for range 20 {
		<-done
	}
}

// TestTokenExpiration verifies that a token is rejected after the TTL has elapsed.
// To avoid a 5-minute wait, we directly insert an expired entry into the map.
func TestTokenExpiration_RejectsExpiredToken(t *testing.T) {
	tm := NewTokenManager()
	defer tm.Close()

	// Manually insert an expired entry (created 6 minutes ago).
	expiredToken := "expired-token-deadbeef"
	tm.mu.Lock()
	tm.tokens[expiredToken] = tokenEntry{
		teamID:    "tid-team-001",
		createdAt: time.Now().Add(-6 * time.Minute),
	}
	tm.mu.Unlock()

	// Validate should reject expired token.
	teamID, ok := tm.Validate(expiredToken)
	assert.False(t, ok, "expired token should be rejected")
	assert.Empty(t, teamID)

	// ValidateAndConsume should also reject.
	teamID, ok = tm.ValidateAndConsume(expiredToken)
	assert.False(t, ok)
	assert.Empty(t, teamID)
}

func TestTokenExpiration_ValidTokenAcceptedWithinTTL(t *testing.T) {
	tm := NewTokenManager()
	defer tm.Close()

	token, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)

	// Token was just generated — must be valid.
	teamID, ok := tm.Validate(token)
	assert.True(t, ok)
	assert.Equal(t, "tid-team-001", teamID)
}

func TestTokenCleanup_RemovesExpiredTokens(t *testing.T) {
	tm := NewTokenManager()
	defer tm.Close()

	// Insert one valid and one expired token.
	validToken := "valid-token-aabbccdd"
	expiredToken := "expired-token-11223344"

	tm.mu.Lock()
	tm.tokens[validToken] = tokenEntry{teamID: "tid-valid", createdAt: time.Now()}
	tm.tokens[expiredToken] = tokenEntry{teamID: "tid-expired", createdAt: time.Now().Add(-10 * time.Minute)}
	tm.mu.Unlock()

	// Run cleanup directly.
	tm.cleanupExpiredTokens()

	// Expired token should be gone; valid token should remain.
	tm.mu.Lock()
	_, expiredPresent := tm.tokens[expiredToken]
	_, validPresent := tm.tokens[validToken]
	tm.mu.Unlock()

	assert.False(t, expiredPresent, "expired token should be removed by cleanup")
	assert.True(t, validPresent, "valid token should remain after cleanup")
}

func TestTokenOneTimeUse_CannotReuseConsumedToken(t *testing.T) {
	tm := NewTokenManager()
	defer tm.Close()

	token, err := tm.GenerateToken("tid-team-001")
	require.NoError(t, err)

	// First use: validate
	teamID, ok := tm.Validate(token)
	assert.True(t, ok)
	assert.Equal(t, "tid-team-001", teamID)

	// Consume
	consumed := tm.Consume(token)
	assert.True(t, consumed)

	// Second use: must fail
	_, ok = tm.Validate(token)
	assert.False(t, ok)

	_, ok = tm.ValidateAndConsume(token)
	assert.False(t, ok)
}

func TestTokenManager_Close_StopsCleanup(t *testing.T) {
	tm := NewTokenManager()
	// Should not panic when closed twice.
	tm.Close()
	tm.Close()
}
