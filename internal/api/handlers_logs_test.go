package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockLS "github.com/Z-M-Huang/openhive/internal/mocks/LogStore"
)

func newLogsTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
}

func sampleLogEntries() []*domain.LogEntry {
	return []*domain.LogEntry{
		{
			ID:        1,
			Level:     domain.LogLevelInfo,
			Component: "orchestrator",
			Action:    "task_created",
			Message:   "Task created",
			CreatedAt: time.Now(),
		},
		{
			ID:        2,
			Level:     domain.LogLevelError,
			Component: "container",
			Action:    "start_failed",
			Message:   "Container failed to start",
			CreatedAt: time.Now(),
		},
	}
}

func TestGetLogs_ReturnsLogEntries(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.Anything).Return(sampleLogEntries(), nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var envelope successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
	require.NotNil(t, envelope.Data)
	ls.AssertExpectations(t)
}

func TestGetLogs_DefaultLimit100(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.MatchedBy(func(opts domain.LogQueryOpts) bool {
		return opts.Limit == 100
	})).Return([]*domain.LogEntry{}, nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ls.AssertExpectations(t)
}

func TestGetLogs_FiltersByLevel(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.MatchedBy(func(opts domain.LogQueryOpts) bool {
		return opts.Level != nil && *opts.Level == domain.LogLevelError
	})).Return(sampleLogEntries(), nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?level=error", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ls.AssertExpectations(t)
}

func TestGetLogs_FiltersByComponent(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.MatchedBy(func(opts domain.LogQueryOpts) bool {
		return opts.Component == "orchestrator"
	})).Return(sampleLogEntries(), nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?component=orchestrator", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ls.AssertExpectations(t)
}

func TestGetLogs_FiltersByTeam(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.MatchedBy(func(opts domain.LogQueryOpts) bool {
		return opts.TeamName == "alpha"
	})).Return(sampleLogEntries(), nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?team=alpha", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ls.AssertExpectations(t)
}

func TestGetLogs_PaginationLimitOffset(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.MatchedBy(func(opts domain.LogQueryOpts) bool {
		return opts.Limit == 25 && opts.Offset == 50
	})).Return([]*domain.LogEntry{}, nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?limit=25&offset=50", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ls.AssertExpectations(t)
}

func TestGetLogs_InvalidLevel_Returns400(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?level=badlevel", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "INVALID_PARAM")
}

func TestGetLogs_MaxLimit1000(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.MatchedBy(func(opts domain.LogQueryOpts) bool {
		return opts.Limit == 1000
	})).Return([]*domain.LogEntry{}, nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	// Request limit=9999 — should be capped to 1000
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?limit=9999", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ls.AssertExpectations(t)
}

func TestGetLogs_StoreError_Returns500(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.Anything).Return(nil, assert.AnError)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestGetLogs_EmptyResult_ReturnsEmptyArray(t *testing.T) {
	ls := mockLS.NewMockLogStore(t)
	ls.On("Query", mock.Anything, mock.Anything).Return(nil, nil)

	handler := GetLogsHandler(ls, newLogsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	// Should return an empty array, not null
	assert.Contains(t, w.Body.String(), "[]")
}
