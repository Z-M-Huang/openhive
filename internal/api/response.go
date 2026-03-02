package api

import (
	"encoding/json"
	"errors"
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
	var nfe *domain.NotFoundError
	var ve *domain.ValidationError
	var ce *domain.ConflictError
	var ele *domain.EncryptionLockedError
	var rle *domain.RateLimitedError

	switch {
	case errors.As(err, &nfe):
		Error(w, http.StatusNotFound, nfe.Code(), "the requested resource was not found")
	case errors.As(err, &ve):
		Error(w, http.StatusBadRequest, ve.Code(), ve.Error())
	case errors.As(err, &ce):
		Error(w, http.StatusConflict, ce.Code(), "a resource conflict occurred")
	case errors.As(err, &ele):
		Error(w, http.StatusForbidden, ele.Code(), "encryption is locked")
	case errors.As(err, &rle):
		w.Header().Set("Retry-After", itoa(rle.RetryAfterSeconds))
		Error(w, http.StatusTooManyRequests, rle.Code(), "rate limit exceeded")
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
