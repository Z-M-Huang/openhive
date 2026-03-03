package domain

import "fmt"

// NotFoundError is returned when a requested resource does not exist.
type NotFoundError struct {
	Resource string
	ID       string
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("%s not found: %s", e.Resource, e.ID)
}

// Code returns the error code for API/WS protocol mapping.
func (e *NotFoundError) Code() string {
	return "NOT_FOUND"
}

// ValidationError is returned when input validation fails.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("validation error on %s: %s", e.Field, e.Message)
	}
	return fmt.Sprintf("validation error: %s", e.Message)
}

// Code returns the error code for API/WS protocol mapping.
func (e *ValidationError) Code() string {
	return "VALIDATION_ERROR"
}

// ConflictError is returned when an operation conflicts with existing state.
type ConflictError struct {
	Resource string
	Message  string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("conflict on %s: %s", e.Resource, e.Message)
}

// Code returns the error code for API/WS protocol mapping.
func (e *ConflictError) Code() string {
	return "CONFLICT"
}

// EncryptionLockedError is returned when encryption operations are attempted
// while the key manager is in a locked state.
type EncryptionLockedError struct {
	Message string
}

func (e *EncryptionLockedError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("encryption locked: %s", e.Message)
	}
	return "encryption locked: master key not set"
}

// Code returns the error code for API/WS protocol mapping.
func (e *EncryptionLockedError) Code() string {
	return "ENCRYPTION_LOCKED"
}

// RateLimitedError is returned when a rate limit is exceeded.
type RateLimitedError struct {
	RetryAfterSeconds int
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("rate limited: retry after %d seconds", e.RetryAfterSeconds)
}

// Code returns the error code for API/WS protocol mapping.
func (e *RateLimitedError) Code() string {
	return "RATE_LIMITED"
}

// AccessDeniedError is returned when an operation is not authorized.
type AccessDeniedError struct {
	Resource string
	Message  string
}

func (e *AccessDeniedError) Error() string {
	if e.Resource != "" {
		return fmt.Sprintf("access denied on %s: %s", e.Resource, e.Message)
	}
	return fmt.Sprintf("access denied: %s", e.Message)
}

// Code returns the error code for API/WS protocol mapping.
func (e *AccessDeniedError) Code() string {
	return "ACCESS_DENIED"
}
