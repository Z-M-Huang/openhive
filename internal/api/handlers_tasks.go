package api

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	defaultTasksLimit = 50
	maxTasksLimit     = 500
)

// tasksResponse wraps a paginated list of tasks.
type tasksResponse struct {
	Tasks   []*domain.Task `json:"tasks"`
	Total   int            `json:"total"`
	HasMore bool           `json:"has_more"`
	Limit   int            `json:"limit"`
	Offset  int            `json:"offset"`
}

// taskWithSubtree adds a subtasks array to a task for tree display.
type taskWithSubtree struct {
	*domain.Task
	Subtasks []*domain.Task `json:"subtasks,omitempty"`
}

// GetTasksHandler returns a handler for GET /api/v1/tasks.
// Supports query params: status, team, limit, offset.
func GetTasksHandler(taskStore domain.TaskStore, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		limit := defaultTasksLimit
		if limitStr := q.Get("limit"); limitStr != "" {
			l, err := strconv.Atoi(limitStr)
			if err != nil || l < 1 {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "limit must be a positive integer")
				return
			}
			if l > maxTasksLimit {
				l = maxTasksLimit
			}
			limit = l
		}

		offset := 0
		if offsetStr := q.Get("offset"); offsetStr != "" {
			o, err := strconv.Atoi(offsetStr)
			if err != nil || o < 0 {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "offset must be a non-negative integer")
				return
			}
			offset = o
		}

		var tasks []*domain.Task
		var err error

		teamSlug := q.Get("team")
		statusStr := q.Get("status")

		switch {
		case teamSlug != "":
			tasks, err = taskStore.ListByTeam(r.Context(), teamSlug)
		case statusStr != "":
			status, parseErr := domain.ParseTaskStatus(statusStr)
			if parseErr != nil {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "invalid task status")
				return
			}
			tasks, err = taskStore.ListByStatus(r.Context(), status)
		default:
			// No filter: list running tasks as a practical default.
			tasks, err = taskStore.ListByStatus(r.Context(), domain.TaskStatusRunning)
			if err != nil {
				// Fallback to empty list on error
				tasks = []*domain.Task{}
				err = nil
			}
		}

		if err != nil {
			logger.Error("failed to list tasks", "error", err)
			Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list tasks")
			return
		}

		total := len(tasks)
		hasMore := false

		// Apply pagination
		if offset < len(tasks) {
			end := offset + limit
			if end > len(tasks) {
				end = len(tasks)
			} else {
				hasMore = true
			}
			tasks = tasks[offset:end]
		} else {
			tasks = []*domain.Task{}
		}

		JSON(w, http.StatusOK, tasksResponse{
			Tasks:   tasks,
			Total:   total,
			HasMore: hasMore,
			Limit:   limit,
			Offset:  offset,
		})
	}
}

// GetTaskHandler returns a handler for GET /api/v1/tasks/{id}.
func GetTaskHandler(taskStore domain.TaskStore, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if id == "" {
			Error(w, http.StatusBadRequest, "INVALID_PARAM", "id is required")
			return
		}

		task, err := taskStore.Get(r.Context(), id)
		if err != nil {
			MapDomainError(w, err)
			return
		}

		// Fetch subtree
		subtree, err := taskStore.GetSubtree(r.Context(), id)
		if err != nil {
			logger.Error("failed to get task subtree", "id", id, "error", err)
			// Non-fatal: return task without subtree
			JSON(w, http.StatusOK, taskWithSubtree{Task: task})
			return
		}

		// Filter out the root task itself from the subtree
		var subtasks []*domain.Task
		for _, t := range subtree {
			if t.ID != id {
				subtasks = append(subtasks, t)
			}
		}

		JSON(w, http.StatusOK, taskWithSubtree{Task: task, Subtasks: subtasks})
	}
}

// CancelTaskHandler returns a handler for POST /api/v1/tasks/{id}/cancel.
func CancelTaskHandler(orch domain.GoOrchestrator, taskStore domain.TaskStore, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Enforce JSON body (even though we don't read it) for CSRF protection
		ct := r.Header.Get("Content-Type")
		if ct != "application/json" {
			Error(w, http.StatusUnsupportedMediaType, "INVALID_CONTENT_TYPE",
				"Content-Type must be application/json")
			return
		}

		id := chi.URLParam(r, "id")
		if id == "" {
			Error(w, http.StatusBadRequest, "INVALID_PARAM", "id is required")
			return
		}

		if err := orch.CancelTask(r.Context(), id); err != nil {
			logger.Error("failed to cancel task", "id", id, "error", err)
			MapDomainError(w, err)
			return
		}

		// Return updated task
		task, err := taskStore.Get(r.Context(), id)
		if err != nil {
			MapDomainError(w, err)
			return
		}

		JSON(w, http.StatusOK, task)
	}
}
