package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockCL "github.com/Z-M-Huang/openhive/internal/mocks/ConfigLoader"
	mockKM "github.com/Z-M-Huang/openhive/internal/mocks/KeyManager"
)

func newConfigTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
}

func sampleMasterConfig() *domain.MasterConfig {
	return &domain.MasterConfig{
		System: domain.SystemConfig{
			ListenAddress: "127.0.0.1:8080",
			LogLevel:      "info",
			DataDir:       "/data",
		},
		Channels: domain.ChannelsConfig{
			Discord: domain.ChannelConfig{
				Enabled:   true,
				Token:     "test-tok",
				ChannelID: "channel-123",
			},
		},
	}
}

func TestMaskSecret_Empty(t *testing.T) {
	assert.Equal(t, "", maskSecret(""))
}

func TestGetConfig_SetsCacheControlNoStore(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	cl.On("LoadMaster").Return(sampleMasterConfig(), nil)
	handler := GetConfigHandler(cl, km, newConfigTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"))
}

func TestPutConfig_RejectsNonJSONContentType(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	handler := PutConfigHandler(cl, newConfigTestLogger())
	body := `{"system":{"log_level":"debug"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/config", strings.NewReader(body))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnsupportedMediaType, w.Code)
}

func TestPutProviders_EncryptsAPIKey_WhenKMUnlocked(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	plainVal := "rawvalue"
	km.On("IsLocked").Return(false)
	km.On("Encrypt", plainVal).Return("encval", nil)
	cl.On("SaveProviders", mock.MatchedBy(func(p map[string]domain.Provider) bool {
		return p["tp"].APIKey == "encval"
	})).Return(nil)
	handler := PutProvidersHandler(cl, km, newConfigTestLogger())
	body := `{"tp":{"name":"tp","type":"anthropic_direct","api_key":"rawvalue"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGetConfig_ResponseShape(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	cl.On("LoadMaster").Return(sampleMasterConfig(), nil)
	handler := GetConfigHandler(cl, km, newConfigTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var envelope successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
	require.NotNil(t, envelope.Data)
	data, ok := envelope.Data.(map[string]interface{})
	require.True(t, ok)
	assert.Contains(t, data, "system")
	assert.Contains(t, data, "channels")
}

func TestSecurityHeadersWithWS_ContainsWSProtocol(t *testing.T) {
	handler := SecurityHeadersWithWS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	csp := w.Header().Get("Content-Security-Policy")
	assert.Contains(t, csp, "ws:")
	assert.Contains(t, csp, "wss:")
}

func TestMaskSecret_Short(t *testing.T) {
	assert.Equal(t, "****", maskSecret("abc"))
	assert.Equal(t, "****", maskSecret("abcd"))
}

func TestMaskSecret_Long(t *testing.T) {
	result := maskSecret("xyzwabcd1234")
	assert.Equal(t, "****1234", result)
}

func TestGetConfig_ReturnsConfig(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	cl.On("LoadMaster").Return(sampleMasterConfig(), nil)
	handler := GetConfigHandler(cl, km, newConfigTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	cl.AssertExpectations(t)
}

func TestGetConfig_StoreError_Returns500(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	cl.On("LoadMaster").Return(nil, assert.AnError)
	handler := GetConfigHandler(cl, km, newConfigTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestPutConfig_UpdatesLogLevel(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	_ = km
	cfg := sampleMasterConfig()
	cl.On("LoadMaster").Return(cfg, nil)
	cl.On("SaveMaster", mock.MatchedBy(func(c *domain.MasterConfig) bool {
		return c.System.LogLevel == "debug"
	})).Return(nil)
	handler := PutConfigHandler(cl, newConfigTestLogger())
	body := `{"system":{"log_level":"debug"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/config", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	cl.AssertExpectations(t)
}

func TestPutConfig_InvalidJSON_Returns400(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	handler := PutConfigHandler(cl, newConfigTestLogger())
	req := httptest.NewRequest(http.MethodPut, "/api/v1/config", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGetProviders_SetsCacheControlNoStore(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	cl.On("LoadProviders").Return(map[string]domain.Provider{}, nil)
	handler := GetProvidersHandler(cl, km, newConfigTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/providers", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"))
}

func TestPutProviders_RejectsNonJSONContentType(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	handler := PutProvidersHandler(cl, km, newConfigTestLogger())
	req := httptest.NewRequest(http.MethodPut, "/api/v1/providers", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnsupportedMediaType, w.Code)
}

func TestPutProviders_SkipsEncryption_WhenKMLocked(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	km.On("IsLocked").Return(true)
	cl.On("SaveProviders", mock.Anything).Return(nil)
	handler := PutProvidersHandler(cl, km, newConfigTestLogger())
	body := `{"tp":{"name":"tp","type":"anthropic_direct","api_key":"rawval"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	km.AssertNotCalled(t, "Encrypt", mock.Anything)
}

func TestRequireJSONBody_RejectsWrongContentType(t *testing.T) {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "text/plain")
	var dst map[string]string
	ok := requireJSONBody(w, req, &dst)
	assert.False(t, ok)
	assert.Equal(t, http.StatusUnsupportedMediaType, w.Code)
}

func TestAllRoutes_RespondWithCorrectCodes(t *testing.T) {
	cl := mockCL.NewMockConfigLoader(t)
	km := mockKM.NewMockKeyManager(t)
	logger := newConfigTestLogger()
	cfg := sampleMasterConfig()
	cl.On("LoadMaster").Return(cfg, nil).Maybe()
	cl.On("LoadProviders").Return(map[string]domain.Provider{}, nil).Maybe()
	deps := ServerDeps{ConfigLoader: cl}
	s := NewServerWithDeps("127.0.0.1:0", logger, km, nil, nil, nil, nil, deps)
	tests := []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodGet, "/api/v1/health", http.StatusOK},
		{http.MethodGet, "/api/v1/config", http.StatusOK},
		{http.MethodGet, "/api/v1/providers", http.StatusOK},
		{http.MethodGet, "/api/v1/nonexistent", http.StatusNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(""))
			w := httptest.NewRecorder()
			s.Router().ServeHTTP(w, req)
			assert.Equal(t, tc.want, w.Code)
		})
	}
}

func TestSecurityHeadersWithWS_ContainsUnsafeInline(t *testing.T) {
	handler := SecurityHeadersWithWS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	csp := w.Header().Get("Content-Security-Policy")
	assert.Contains(t, csp, "unsafe-inline")
}
