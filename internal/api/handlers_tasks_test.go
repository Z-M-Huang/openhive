package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockGO "github.com/Z-M-Huang/openhive/internal/mocks/GoOrchestrator"
	mockTS "github.com/Z-M-Huang/openhive/internal/mocks/TaskStore"
)

func newTasksTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
}

func sampleTask(id, teamSlug string, status domain.TaskStatus) *domain.Task {
	return &domain.Task{
		ID:        id,
		TeamSlug:  teamSlug,
		Status:    status,
		Prompt:    "Do the thing",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
}

func serveTaskWithChi(method, path, routePattern string, handler http.HandlerFunc) *httptest.ResponseRecorder {
	r := chi.NewRouter()
	r.MethodFunc(method, routePattern, handler)
	req := httptest.NewRequest(method, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func serveTaskWithChiBody(method, path, routePattern string, handler http.HandlerFunc, body string, ct string) *httptest.ResponseRecorder {
	r := chi.NewRouter()
	r.MethodFunc(method, routePattern, handler)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestGetTasks_ReturnsPaginatedList(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	tasks := []*domain.Task{
		sampleTask("tid-task-00000001", "alpha", domain.TaskStatusRunning),
		sampleTask("tid-task-00000002", "alpha", domain.TaskStatusRunning),
	}
	ts.On("ListByStatus", mock.Anything, domain.TaskStatusRunning).Return(tasks, nil)

	handler := GetTasksHandler(ts, newTasksTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/tasks", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var envelope successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
	require.NotNil(t, envelope.Data)
	ts.AssertExpectations(t)
}

func TestGetTasks_FiltersByStatus(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	ts.On("ListByStatus", mock.Anything, domain.TaskStatusCompleted).Return([]*domain.Task{
		sampleTask("tid-task-00000001", "alpha", domain.TaskStatusCompleted),
	}, nil)

	handler := GetTasksHandler(ts, newTasksTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/tasks?status=completed", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ts.AssertExpectations(t)
}

func TestGetTasks_FiltersByTeam(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	ts.On("ListByTeam", mock.Anything, "alpha").Return([]*domain.Task{
		sampleTask("tid-task-00000001", "alpha", domain.TaskStatusRunning),
	}, nil)

	handler := GetTasksHandler(ts, newTasksTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/tasks?team=alpha", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	ts.AssertExpectations(t)
}

func TestGetTasks_InvalidStatus_Returns400(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)

	handler := GetTasksHandler(ts, newTasksTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/tasks?status=badstatus", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGetTaskByID_ReturnsTaskWithSubtree(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	task := sampleTask("tid-task-00000001", "alpha", domain.TaskStatusRunning)
	child := sampleTask("tid-task-00000002", "alpha", domain.TaskStatusPending)
	child.ParentID = task.ID

	ts.On("Get", mock.Anything, "tid-task-00000001").Return(task, nil)
	ts.On("GetSubtree", mock.Anything, "tid-task-00000001").Return([]*domain.Task{task, child}, nil)

	handler := GetTaskHandler(ts, newTasksTestLogger())
	w := serveTaskWithChi(http.MethodGet, "/api/v1/tasks/tid-task-00000001", "/api/v1/tasks/{id}", handler)

	assert.Equal(t, http.StatusOK, w.Code)

	var envelope successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
	require.NotNil(t, envelope.Data)
	ts.AssertExpectations(t)
}

func TestGetTaskByID_NotFound(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	ts.On("Get", mock.Anything, "nonexistent").Return(nil, &domain.NotFoundError{Resource: "task", ID: "nonexistent"})

	handler := GetTaskHandler(ts, newTasksTestLogger())
	w := serveTaskWithChi(http.MethodGet, "/api/v1/tasks/nonexistent", "/api/v1/tasks/{id}", handler)

	assert.Equal(t, http.StatusNotFound, w.Code)
	ts.AssertExpectations(t)
}

func TestCancelTask_Success(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	orch := mockGO.NewMockGoOrchestrator(t)
	task := sampleTask("tid-task-00000001", "alpha", domain.TaskStatusCancelled)

	orch.On("CancelTask", mock.Anything, "tid-task-00000001").Return(nil)
	ts.On("Get", mock.Anything, "tid-task-00000001").Return(task, nil)

	handler := CancelTaskHandler(orch, ts, newTasksTestLogger())
	w := serveTaskWithChiBody(
		http.MethodPost, "/api/v1/tasks/tid-task-00000001/cancel",
		"/api/v1/tasks/{id}/cancel",
		handler,
		`{}`,
		"application/json",
	)

	assert.Equal(t, http.StatusOK, w.Code)
	orch.AssertExpectations(t)
	ts.AssertExpectations(t)
}

func TestCancelTask_RejectsNonJSON(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	orch := mockGO.NewMockGoOrchestrator(t)

	handler := CancelTaskHandler(orch, ts, newTasksTestLogger())
	w := serveTaskWithChiBody(
		http.MethodPost, "/api/v1/tasks/tid-task-00000001/cancel",
		"/api/v1/tasks/{id}/cancel",
		handler,
		`{}`,
		"text/plain",
	)

	assert.Equal(t, http.StatusUnsupportedMediaType, w.Code)
}

func TestCancelTask_NotFound(t *testing.T) {
	ts := mockTS.NewMockTaskStore(t)
	orch := mockGO.NewMockGoOrchestrator(t)
	orch.On("CancelTask", mock.Anything, "nonexistent").Return(&domain.NotFoundError{Resource: "task", ID: "nonexistent"})

	handler := CancelTaskHandler(orch, ts, newTasksTestLogger())
	w := serveTaskWithChiBody(
		http.MethodPost, "/api/v1/tasks/nonexistent/cancel",
		"/api/v1/tasks/{id}/cancel",
		handler,
		`{}`,
		"application/json",
	)

	assert.Equal(t, http.StatusNotFound, w.Code)
	orch.AssertExpectations(t)
}
