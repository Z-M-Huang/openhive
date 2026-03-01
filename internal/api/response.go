package api

import (
	"encoding/json"
	"net/http"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// successResponse wraps a data payload in a success response.
type successResponse struct {
	Data interface{} `json:"data"`
}

// errorResponse wraps an error in a structured response.
type errorResponse struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// JSON writes a JSON success response.
func JSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(successResponse{Data: data})
}

// Error writes a JSON error response.
func Error(w http.ResponseWriter, status int, code string, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorResponse{
		Error: errorBody{Code: code, Message: message},
	})
}

// MapDomainError maps domain errors to HTTP status codes and writes the response.
func MapDomainError(w http.ResponseWriter, err error) {
	switch e := err.(type) {
	case *domain.NotFoundError:
		Error(w, http.StatusNotFound, e.Code(), "the requested resource was not found")
	case *domain.ValidationError:
		Error(w, http.StatusBadRequest, e.Code(), e.Error())
	case *domain.ConflictError:
		Error(w, http.StatusConflict, e.Code(), "a resource conflict occurred")
	case *domain.EncryptionLockedError:
		Error(w, http.StatusForbidden, e.Code(), "encryption is locked")
	case *domain.RateLimitedError:
		w.Header().Set("Retry-After", itoa(e.RetryAfterSeconds))
		Error(w, http.StatusTooManyRequests, e.Code(), "rate limit exceeded")
	default:
		Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "an internal error occurred")
	}
}

func itoa(i int) string {
	if i < 0 {
		return "-" + itoa(-i)
	}
	if i < 10 {
		return string(rune('0' + i))
	}
	return itoa(i/10) + string(rune('0'+i%10))
}
