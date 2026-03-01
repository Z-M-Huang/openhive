package ws

import (
	"testing"

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
