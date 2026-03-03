package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// Deps holds handler dependencies.
type Deps struct {
	KeyManager domain.KeyManager
}

// DroppedLogCounter provides the count of dropped log entries.
// Implemented by logging.DBLogger.
type DroppedLogCounter interface {
	DroppedCount() int64
}

// HealthHandler returns the health check handler.
// If a DroppedLogCounter is provided (non-nil), the dropped_log_entries field
// is included in the response.
func HealthHandler(startTime time.Time, dbLogger DroppedLogCounter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uptime := time.Since(startTime).Truncate(time.Second).String()
		resp := map[string]interface{}{
			"status":  "ok",
			"version": "0.1.0",
			"uptime":  uptime,
		}
		if dbLogger != nil {
			resp["dropped_log_entries"] = dbLogger.DroppedCount()
		}
		JSON(w, http.StatusOK, resp)
	}
}

type unlockRequest struct {
	MasterKey string `json:"master_key"`
}

// UnlockHandler returns the unlock endpoint handler.
func UnlockHandler(km domain.KeyManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req unlockRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			Error(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid JSON body")
			return
		}

		if req.MasterKey == "" {
			Error(w, http.StatusBadRequest, "VALIDATION_ERROR", "master_key is required")
			return
		}

		err := km.Unlock(req.MasterKey)
		if err != nil {
			MapDomainError(w, err)
			return
		}

		JSON(w, http.StatusOK, map[string]string{
			"status": "unlocked",
		})
	}
}

// NotFoundHandler returns a JSON 404 response for unmatched routes.
func NotFoundHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		Error(w, http.StatusNotFound, "NOT_FOUND", "the requested resource was not found")
	}
}
