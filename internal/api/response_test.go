package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestJSON(t *testing.T) {
	w := httptest.NewRecorder()
	data := map[string]string{"key": "value"}
	JSON(w, http.StatusOK, data)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var resp successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	m, ok := resp.Data.(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "value", m["key"])
}

func TestJSON_Created(t *testing.T) {
	w := httptest.NewRecorder()
	JSON(w, http.StatusCreated, map[string]string{"id": "abc"})

	assert.Equal(t, http.StatusCreated, w.Code)
	assert.Contains(t, w.Body.String(), `"id":"abc"`)
}

func TestError(t *testing.T) {
	w := httptest.NewRecorder()
	Error(w, http.StatusBadRequest, "VALIDATION_ERROR", "field is required")

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "VALIDATION_ERROR", resp.Error.Code)
	assert.Equal(t, "field is required", resp.Error.Message)
}

func TestMapDomainError_NotFound(t *testing.T) {
	w := httptest.NewRecorder()
	MapDomainError(w, &domain.NotFoundError{Resource: "task", ID: "123"})

	assert.Equal(t, http.StatusNotFound, w.Code)
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "NOT_FOUND", resp.Error.Code)
	assert.Equal(t, "the requested resource was not found", resp.Error.Message)
}

func TestMapDomainError_Validation(t *testing.T) {
	w := httptest.NewRecorder()
	MapDomainError(w, &domain.ValidationError{Field: "name", Message: "too short"})

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "VALIDATION_ERROR", resp.Error.Code)
	// Validation messages are user-facing and should be preserved
	assert.Contains(t, resp.Error.Message, "too short")
}

func TestMapDomainError_Conflict(t *testing.T) {
	w := httptest.NewRecorder()
	MapDomainError(w, &domain.ConflictError{Resource: "team", Message: "already exists"})

	assert.Equal(t, http.StatusConflict, w.Code)
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "CONFLICT", resp.Error.Code)
	assert.Equal(t, "a resource conflict occurred", resp.Error.Message)
}

func TestMapDomainError_EncryptionLocked(t *testing.T) {
	w := httptest.NewRecorder()
	MapDomainError(w, &domain.EncryptionLockedError{})

	assert.Equal(t, http.StatusForbidden, w.Code)
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "ENCRYPTION_LOCKED", resp.Error.Code)
	assert.Equal(t, "encryption is locked", resp.Error.Message)
}

func TestMapDomainError_RateLimited(t *testing.T) {
	w := httptest.NewRecorder()
	MapDomainError(w, &domain.RateLimitedError{RetryAfterSeconds: 45})

	assert.Equal(t, http.StatusTooManyRequests, w.Code)
	assert.Equal(t, "45", w.Header().Get("Retry-After"))
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "RATE_LIMITED", resp.Error.Code)
	assert.Equal(t, "rate limit exceeded", resp.Error.Message)
}

func TestMapDomainError_Unknown(t *testing.T) {
	w := httptest.NewRecorder()
	MapDomainError(w, assert.AnError)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "INTERNAL_ERROR", resp.Error.Code)
	assert.Equal(t, "an internal error occurred", resp.Error.Message)
}

func TestMapDomainError_WrappedNotFound(t *testing.T) {
	w := httptest.NewRecorder()
	wrapped := fmt.Errorf("outer: %w", &domain.NotFoundError{Resource: "team", ID: "x"})
	MapDomainError(w, wrapped)

	assert.Equal(t, http.StatusNotFound, w.Code)
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "NOT_FOUND", resp.Error.Code)
	assert.Equal(t, "the requested resource was not found", resp.Error.Message)
}

func TestMapDomainError_WrappedValidation(t *testing.T) {
	w := httptest.NewRecorder()
	wrapped := fmt.Errorf("lookup failed: %w", &domain.ValidationError{Field: "slug", Message: "invalid"})
	MapDomainError(w, wrapped)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp errorResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "VALIDATION_ERROR", resp.Error.Code)
	assert.Contains(t, resp.Error.Message, "invalid")
}

func TestItoa(t *testing.T) {
	tests := []struct {
		input    int
		expected string
	}{
		{0, "0"},
		{1, "1"},
		{9, "9"},
		{10, "10"},
		{42, "42"},
		{100, "100"},
		{-1, "-1"},
		{-42, "-42"},
	}
	for _, tt := range tests {
		assert.Equal(t, tt.expected, itoa(tt.input), "itoa(%d)", tt.input)
	}
}
