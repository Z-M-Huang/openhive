package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	mockkm "github.com/Z-M-Huang/openhive/internal/mocks/KeyManager"
)

func newTestServer(t *testing.T) (*Server, *mockkm.MockKeyManager) {
	t.Helper()
	km := mockkm.NewMockKeyManager(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	spaFS := fstest.MapFS{
		"index.html": {Data: []byte("<html>test</html>")},
	}

	s := NewServer(
		"127.0.0.1:0",
		logger,
		km,
		spaFS,
		nil,
		nil,
		[]string{"http://localhost:3000"},
	)
	return s, km
}

func TestServer_HealthEndpoint(t *testing.T) {
	s, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var resp successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	data, ok := resp.Data.(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "ok", data["status"])
}

func TestServer_HealthEndpoint_HasRequestID(t *testing.T) {
	s, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.NotEmpty(t, w.Header().Get("X-Request-ID"))
}

func TestServer_HealthEndpoint_HasSecurityHeaders(t *testing.T) {
	s, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, "nosniff", w.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, "DENY", w.Header().Get("X-Frame-Options"))
	assert.Equal(t, "default-src 'self'", w.Header().Get("Content-Security-Policy"))
}

func TestServer_UnlockEndpoint_Success(t *testing.T) {
	s, km := newTestServer(t)
	km.On("Unlock", "super-secret-master-key-1234").Return(nil)

	body := `{"master_key": "super-secret-master-key-1234"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "unlocked")
	km.AssertExpectations(t)
}

func TestServer_UnlockEndpoint_InvalidKey(t *testing.T) {
	s, km := newTestServer(t)
	km.On("Unlock", mock.AnythingOfType("string")).Return(
		&domain.ValidationError{Field: "master_key", Message: "too short"},
	)

	body := `{"master_key": "short"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	km.AssertExpectations(t)
}

func TestServer_UnlockEndpoint_RateLimited(t *testing.T) {
	s, km := newTestServer(t)
	km.On("Unlock", mock.AnythingOfType("string")).Return(
		&domain.RateLimitedError{RetryAfterSeconds: 45},
	)

	body := `{"master_key": "some-attempt-key-long-enough-123"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/unlock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, http.StatusTooManyRequests, w.Code)
	assert.Equal(t, "45", w.Header().Get("Retry-After"))
	km.AssertExpectations(t)
}

func TestServer_NotFound_ReturnsJSON(t *testing.T) {
	// Create server without SPA FS to test JSON 404
	km := mockkm.NewMockKeyManager(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	s := NewServer("127.0.0.1:0", logger, km, nil, nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nonexistent", nil)
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "NOT_FOUND")
}

func TestServer_SPA_FallbackToIndex(t *testing.T) {
	s, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "test")
}

func TestServer_CORS_WithAllowedOrigin(t *testing.T) {
	s, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, "http://localhost:3000", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestServer_CORS_WithDisallowedOrigin(t *testing.T) {
	s, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("Origin", "http://evil.com")
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
}

func TestServer_DefaultBindAddress(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	s := NewServer("127.0.0.1:8080", logger, km, nil, nil, nil, nil)

	assert.Equal(t, "127.0.0.1:8080", s.httpServer.Addr)
}

func TestServer_GracefulShutdown(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	// Find a free port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	listener.Close()

	s := NewServer(addr, logger, km, nil, nil, nil, nil)

	// Start server in background
	errCh := make(chan error, 1)
	go func() {
		errCh <- s.Start()
	}()

	// Wait for server to be ready
	require.Eventually(t, func() bool {
		conn, dialErr := net.Dial("tcp", addr)
		if dialErr != nil {
			return false
		}
		conn.Close()
		return true
	}, 2*time.Second, 10*time.Millisecond)

	// Shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, s.Shutdown(ctx))

	// Start should return nil (ErrServerClosed is swallowed)
	startErr := <-errCh
	assert.NoError(t, startErr)
}

func TestServer_WithWSHandler(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	var wsCalled bool
	wsHandler := func(w http.ResponseWriter, r *http.Request) {
		wsCalled = true
		w.WriteHeader(http.StatusOK)
	}

	s := NewServer("127.0.0.1:0", logger, km, nil, wsHandler, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/ws/container", nil)
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.True(t, wsCalled)
}

func TestServer_WithChatHandler(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	var chatCalled bool
	chatHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chatCalled = true
		w.WriteHeader(http.StatusOK)
	})

	s := NewServer("127.0.0.1:0", logger, km, nil, nil, chatHandler, nil)

	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.True(t, chatCalled)
}

func TestServer_NoChatHandler_Returns404(t *testing.T) {
	km := mockkm.NewMockKeyManager(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	s := NewServer("127.0.0.1:0", logger, km, nil, nil, nil, nil)

	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}
