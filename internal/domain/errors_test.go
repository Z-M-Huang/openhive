package domain

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNotFoundError(t *testing.T) {
	err := &NotFoundError{Resource: "team", ID: "my-team"}
	assert.Equal(t, "team not found: my-team", err.Error())
	assert.Equal(t, "NOT_FOUND", err.Code())

	var nfe *NotFoundError
	assert.True(t, errors.As(err, &nfe))
	assert.Equal(t, "team", nfe.Resource)
	assert.Equal(t, "my-team", nfe.ID)
}

func TestValidationError(t *testing.T) {
	err := &ValidationError{Field: "slug", Message: "cannot be empty"}
	assert.Equal(t, "validation error on slug: cannot be empty", err.Error())
	assert.Equal(t, "VALIDATION_ERROR", err.Code())

	var ve *ValidationError
	assert.True(t, errors.As(err, &ve))

	errNoField := &ValidationError{Message: "something wrong"}
	assert.Equal(t, "validation error: something wrong", errNoField.Error())
}

func TestConflictError(t *testing.T) {
	err := &ConflictError{Resource: "agent", Message: "AID already exists"}
	assert.Equal(t, "conflict on agent: AID already exists", err.Error())
	assert.Equal(t, "CONFLICT", err.Code())

	var ce *ConflictError
	assert.True(t, errors.As(err, &ce))
}

func TestEncryptionLockedError(t *testing.T) {
	err := &EncryptionLockedError{}
	assert.Equal(t, "encryption locked: master key not set", err.Error())
	assert.Equal(t, "ENCRYPTION_LOCKED", err.Code())

	errMsg := &EncryptionLockedError{Message: "custom msg"}
	assert.Equal(t, "encryption locked: custom msg", errMsg.Error())

	var ele *EncryptionLockedError
	assert.True(t, errors.As(err, &ele))
}

func TestRateLimitedError(t *testing.T) {
	err := &RateLimitedError{RetryAfterSeconds: 30}
	assert.Equal(t, "rate limited: retry after 30 seconds", err.Error())
	assert.Equal(t, "RATE_LIMITED", err.Code())

	var rle *RateLimitedError
	assert.True(t, errors.As(err, &rle))
	assert.Equal(t, 30, rle.RetryAfterSeconds)
}

func TestErrorInterfaceCompliance(t *testing.T) {
	// All error types implement the error interface
	var _ error = &NotFoundError{}
	var _ error = &ValidationError{}
	var _ error = &ConflictError{}
	var _ error = &EncryptionLockedError{}
	var _ error = &RateLimitedError{}
}
