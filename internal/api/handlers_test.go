package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	mockkm "github.com/Z-M-Huang/openhive/internal/mocks/KeyManager"
)

func TestHealthHandler(t *testing.T) {
	startTime := time.Now().Add(-5 * time.Minute)
	handler := HealthHandler(startTime, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var resp successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	data, ok := resp.Data.(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "ok", data["status"])
	assert.Equal(t, "0.1.0", data["version"])
	assert.NotEmpty(t, data["uptime"])
	// No dbLogger provided — field should be absent
	_, hasDropped := data["dropped_log_entries"]
	assert.False(t, hasDropped, "dropped_log_entries should not be present when dbLogger is nil")
}

// mockDroppedCounter is a test implementation of DroppedLogCounter.
type mockDroppedCounter struct{ count int64 }

func (m *mockDroppedCounter) DroppedCount() int64 { return m.count }

func TestHealthHandler_WithDroppedLogCounter(t *testing.T) {
	startTime := time.Now().Add(-1 * time.Minute)
	counter := &mockDroppedCounter{count: 7}
	handler := HealthHandler(startTime, counter)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	data, ok := resp.Data.(map[string]interface{})
	require.True(t, ok)
	// JSON numbers deserialize as float64
	assert.Equal(t, float64(7), data["dropped_log_entries"])
}

func TestUnlockHandler_Success(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	km.On("Unlock", "my-super-secret-master-key-1234").Return(nil)

	handler := UnlockHandler(km)

	body := `{"master_key": "my-super-secret-master-key-1234"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"unlocked"`)
	km.AssertExpectations(t)
}

func TestUnlockHandler_InvalidKey(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	km.On("Unlock", mock.AnythingOfType("string")).Return(
		&domain.ValidationError{Field: "master_key", Message: "master key must be at least 16 characters"},
	)

	handler := UnlockHandler(km)

	body := `{"master_key": "short"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "VALIDATION_ERROR")
	km.AssertExpectations(t)
}

func TestUnlockHandler_RateLimited(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	km.On("Unlock", mock.AnythingOfType("string")).Return(
		&domain.RateLimitedError{RetryAfterSeconds: 30},
	)

	handler := UnlockHandler(km)

	body := `{"master_key": "some-attempt-key-that-is-long-enough"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusTooManyRequests, w.Code)
	assert.Equal(t, "30", w.Header().Get("Retry-After"))
	assert.Contains(t, w.Body.String(), "RATE_LIMITED")
	km.AssertExpectations(t)
}

func TestUnlockHandler_MissingKey(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)

	handler := UnlockHandler(km)

	body := `{"master_key": ""}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "VALIDATION_ERROR")
	assert.Contains(t, w.Body.String(), "master_key is required")
}

func TestUnlockHandler_InvalidJSON(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)

	handler := UnlockHandler(km)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "INVALID_REQUEST")
}

func TestUnlockHandler_EmptyBody(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)

	handler := UnlockHandler(km)

	body := `{}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "VALIDATION_ERROR")
}

func TestNotFoundHandler(t *testing.T) {
	handler := NotFoundHandler()

	req := httptest.NewRequest(http.MethodGet, "/nonexistent", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "NOT_FOUND")
}
