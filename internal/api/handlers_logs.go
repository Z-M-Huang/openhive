package api

import (
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	defaultLogsLimit = 100
	maxLogsLimit     = 1000
)

// GetLogsHandler returns a handler for GET /api/v1/logs.
// Supports query params: level, component, team, agent, task_id, since, until, limit, offset.
func GetLogsHandler(logStore domain.LogStore, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		opts := domain.LogQueryOpts{}

		// Parse level filter
		if levelStr := q.Get("level"); levelStr != "" {
			level, err := domain.ParseLogLevel(levelStr)
			if err != nil {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "invalid log level")
				return
			}
			opts.Level = &level
		}

		// Parse string filters (these are literal values, no injection risk via ORM)
		opts.Component = q.Get("component")
		opts.TeamName = q.Get("team")
		opts.AgentName = q.Get("agent")
		opts.TaskID = q.Get("task_id")

		// Parse time filters
		if sinceStr := q.Get("since"); sinceStr != "" {
			t, err := time.Parse(time.RFC3339, sinceStr)
			if err != nil {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "since must be RFC3339 timestamp")
				return
			}
			opts.Since = &t
		}
		if untilStr := q.Get("until"); untilStr != "" {
			t, err := time.Parse(time.RFC3339, untilStr)
			if err != nil {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "until must be RFC3339 timestamp")
				return
			}
			opts.Until = &t
		}

		// Parse pagination
		opts.Limit = defaultLogsLimit
		if limitStr := q.Get("limit"); limitStr != "" {
			limit, err := strconv.Atoi(limitStr)
			if err != nil || limit < 1 {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "limit must be a positive integer")
				return
			}
			if limit > maxLogsLimit {
				limit = maxLogsLimit
			}
			opts.Limit = limit
		}
		if offsetStr := q.Get("offset"); offsetStr != "" {
			offset, err := strconv.Atoi(offsetStr)
			if err != nil || offset < 0 {
				Error(w, http.StatusBadRequest, "INVALID_PARAM", "offset must be a non-negative integer")
				return
			}
			opts.Offset = offset
		}

		entries, err := logStore.Query(r.Context(), opts)
		if err != nil {
			logger.Error("failed to query logs", "error", err)
			Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to query logs")
			return
		}

		// Return empty array rather than null
		if entries == nil {
			entries = []*domain.LogEntry{}
		}

		JSON(w, http.StatusOK, entries)
	}
}
