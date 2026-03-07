/**
 * Tests for domain error classes.
 *
 * Verifies that each TypeScript error class:
 *   - Produces the exact same message format as the Go counterpart
 *   - Returns the correct code string
 *   - Passes instanceof checks
 *   - Works correctly with type guard functions
 */

import { describe, it, expect } from 'vitest';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  EncryptionLockedError,
  RateLimitedError,
  AccessDeniedError,
  isNotFoundError,
  isValidationError,
  isConflictError,
  isEncryptionLockedError,
  isRateLimitedError,
  isAccessDeniedError,
} from './errors.js';

// ---------------------------------------------------------------------------
// NotFoundError
// ---------------------------------------------------------------------------

describe('NotFoundError', () => {
  it('produces message matching Go format: "{resource} not found: {id}"', () => {
    const err = new NotFoundError('task', 'abc123');
    expect(err.message).toBe('task not found: abc123');
  });

  it('works with different resource types', () => {
    expect(new NotFoundError('agent', 'aid-abc-xyz').message).toBe('agent not found: aid-abc-xyz');
    expect(new NotFoundError('team', 'tid-abc-xyz').message).toBe('team not found: tid-abc-xyz');
    expect(new NotFoundError('session', 'sess-1').message).toBe('session not found: sess-1');
  });

  it('returns code NOT_FOUND', () => {
    const err = new NotFoundError('task', 'abc123');
    expect(err.code).toBe('NOT_FOUND');
  });

  it('is an instance of Error', () => {
    const err = new NotFoundError('task', 'abc123');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of NotFoundError', () => {
    const err = new NotFoundError('task', 'abc123');
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('exposes resource and id properties', () => {
    const err = new NotFoundError('task', 'abc123');
    expect(err.resource).toBe('task');
    expect(err.id).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('produces message with field: "validation error on {field}: {message}"', () => {
    const err = new ValidationError('name', 'must not be empty');
    expect(err.message).toBe('validation error on name: must not be empty');
  });

  it('produces message without field: "validation error: {message}" when field is empty string', () => {
    const err = new ValidationError('', 'invalid configuration');
    expect(err.message).toBe('validation error: invalid configuration');
  });

  it('returns code VALIDATION_ERROR', () => {
    const err = new ValidationError('name', 'must not be empty');
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('is an instance of Error', () => {
    expect(new ValidationError('field', 'msg')).toBeInstanceOf(Error);
  });

  it('is an instance of ValidationError', () => {
    expect(new ValidationError('field', 'msg')).toBeInstanceOf(ValidationError);
  });

  it('exposes field and validationMessage properties', () => {
    const err = new ValidationError('slug', 'must be lowercase');
    expect(err.field).toBe('slug');
    expect(err.validationMessage).toBe('must be lowercase');
  });
});

// ---------------------------------------------------------------------------
// ConflictError
// ---------------------------------------------------------------------------

describe('ConflictError', () => {
  it('produces message matching Go format: "conflict on {resource}: {message}"', () => {
    const err = new ConflictError('team', 'slug already exists');
    expect(err.message).toBe('conflict on team: slug already exists');
  });

  it('returns code CONFLICT', () => {
    const err = new ConflictError('team', 'slug already exists');
    expect(err.code).toBe('CONFLICT');
  });

  it('is an instance of Error', () => {
    expect(new ConflictError('agent', 'aid already in use')).toBeInstanceOf(Error);
  });

  it('is an instance of ConflictError', () => {
    expect(new ConflictError('agent', 'aid already in use')).toBeInstanceOf(ConflictError);
  });

  it('exposes resource and conflictMessage properties', () => {
    const err = new ConflictError('team', 'slug already exists');
    expect(err.resource).toBe('team');
    expect(err.conflictMessage).toBe('slug already exists');
  });
});

// ---------------------------------------------------------------------------
// EncryptionLockedError
// ---------------------------------------------------------------------------

describe('EncryptionLockedError', () => {
  it('produces default message when no argument provided: "encryption locked: master key not set"', () => {
    const err = new EncryptionLockedError();
    expect(err.message).toBe('encryption locked: master key not set');
  });

  it('produces default message when undefined is passed', () => {
    const err = new EncryptionLockedError(undefined);
    expect(err.message).toBe('encryption locked: master key not set');
  });

  it('produces default message when empty string is passed (mirrors Go empty-string check)', () => {
    const err = new EncryptionLockedError('');
    expect(err.message).toBe('encryption locked: master key not set');
  });

  it('produces custom message: "encryption locked: {message}"', () => {
    const err = new EncryptionLockedError('awaiting unlock');
    expect(err.message).toBe('encryption locked: awaiting unlock');
  });

  it('returns code ENCRYPTION_LOCKED', () => {
    expect(new EncryptionLockedError().code).toBe('ENCRYPTION_LOCKED');
    expect(new EncryptionLockedError('custom').code).toBe('ENCRYPTION_LOCKED');
  });

  it('is an instance of Error', () => {
    expect(new EncryptionLockedError()).toBeInstanceOf(Error);
  });

  it('is an instance of EncryptionLockedError', () => {
    expect(new EncryptionLockedError()).toBeInstanceOf(EncryptionLockedError);
  });
});

// ---------------------------------------------------------------------------
// RateLimitedError
// ---------------------------------------------------------------------------

describe('RateLimitedError', () => {
  it('produces message matching Go format: "rate limited: retry after {n} seconds"', () => {
    const err = new RateLimitedError(30);
    expect(err.message).toBe('rate limited: retry after 30 seconds');
  });

  it('works with different retry values', () => {
    expect(new RateLimitedError(0).message).toBe('rate limited: retry after 0 seconds');
    expect(new RateLimitedError(60).message).toBe('rate limited: retry after 60 seconds');
    expect(new RateLimitedError(1).message).toBe('rate limited: retry after 1 seconds');
  });

  it('returns code RATE_LIMITED', () => {
    const err = new RateLimitedError(30);
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('is an instance of Error', () => {
    expect(new RateLimitedError(10)).toBeInstanceOf(Error);
  });

  it('is an instance of RateLimitedError', () => {
    expect(new RateLimitedError(10)).toBeInstanceOf(RateLimitedError);
  });

  it('exposes retryAfterSeconds property', () => {
    const err = new RateLimitedError(45);
    expect(err.retryAfterSeconds).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// AccessDeniedError
// ---------------------------------------------------------------------------

describe('AccessDeniedError', () => {
  it('produces message with resource: "access denied on {resource}: {message}"', () => {
    const err = new AccessDeniedError('team', 'only the owner may delete');
    expect(err.message).toBe('access denied on team: only the owner may delete');
  });

  it('produces message without resource: "access denied: {message}" when resource is empty string', () => {
    const err = new AccessDeniedError('', 'insufficient permissions');
    expect(err.message).toBe('access denied: insufficient permissions');
  });

  it('returns code ACCESS_DENIED', () => {
    const err = new AccessDeniedError('task', 'not the owner');
    expect(err.code).toBe('ACCESS_DENIED');
  });

  it('is an instance of Error', () => {
    expect(new AccessDeniedError('task', 'denied')).toBeInstanceOf(Error);
  });

  it('is an instance of AccessDeniedError', () => {
    expect(new AccessDeniedError('task', 'denied')).toBeInstanceOf(AccessDeniedError);
  });

  it('exposes resource and denialMessage properties', () => {
    const err = new AccessDeniedError('team', 'not the owner');
    expect(err.resource).toBe('team');
    expect(err.denialMessage).toBe('not the owner');
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('Type guards', () => {
  const notFound = new NotFoundError('task', 'abc');
  const validation = new ValidationError('field', 'msg');
  const conflict = new ConflictError('team', 'exists');
  const locked = new EncryptionLockedError();
  const rateLimited = new RateLimitedError(30);
  const accessDenied = new AccessDeniedError('task', 'denied');
  const plain = new Error('plain error');

  it('isNotFoundError returns true only for NotFoundError', () => {
    expect(isNotFoundError(notFound)).toBe(true);
    expect(isNotFoundError(validation)).toBe(false);
    expect(isNotFoundError(conflict)).toBe(false);
    expect(isNotFoundError(locked)).toBe(false);
    expect(isNotFoundError(rateLimited)).toBe(false);
    expect(isNotFoundError(accessDenied)).toBe(false);
    expect(isNotFoundError(plain)).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError('string')).toBe(false);
  });

  it('isValidationError returns true only for ValidationError', () => {
    expect(isValidationError(validation)).toBe(true);
    expect(isValidationError(notFound)).toBe(false);
    expect(isValidationError(conflict)).toBe(false);
    expect(isValidationError(locked)).toBe(false);
    expect(isValidationError(rateLimited)).toBe(false);
    expect(isValidationError(accessDenied)).toBe(false);
    expect(isValidationError(plain)).toBe(false);
    expect(isValidationError(null)).toBe(false);
  });

  it('isConflictError returns true only for ConflictError', () => {
    expect(isConflictError(conflict)).toBe(true);
    expect(isConflictError(notFound)).toBe(false);
    expect(isConflictError(validation)).toBe(false);
    expect(isConflictError(locked)).toBe(false);
    expect(isConflictError(rateLimited)).toBe(false);
    expect(isConflictError(accessDenied)).toBe(false);
    expect(isConflictError(plain)).toBe(false);
    expect(isConflictError(null)).toBe(false);
  });

  it('isEncryptionLockedError returns true only for EncryptionLockedError', () => {
    expect(isEncryptionLockedError(locked)).toBe(true);
    expect(isEncryptionLockedError(notFound)).toBe(false);
    expect(isEncryptionLockedError(validation)).toBe(false);
    expect(isEncryptionLockedError(conflict)).toBe(false);
    expect(isEncryptionLockedError(rateLimited)).toBe(false);
    expect(isEncryptionLockedError(accessDenied)).toBe(false);
    expect(isEncryptionLockedError(plain)).toBe(false);
    expect(isEncryptionLockedError(null)).toBe(false);
  });

  it('isRateLimitedError returns true only for RateLimitedError', () => {
    expect(isRateLimitedError(rateLimited)).toBe(true);
    expect(isRateLimitedError(notFound)).toBe(false);
    expect(isRateLimitedError(validation)).toBe(false);
    expect(isRateLimitedError(conflict)).toBe(false);
    expect(isRateLimitedError(locked)).toBe(false);
    expect(isRateLimitedError(accessDenied)).toBe(false);
    expect(isRateLimitedError(plain)).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });

  it('isAccessDeniedError returns true only for AccessDeniedError', () => {
    expect(isAccessDeniedError(accessDenied)).toBe(true);
    expect(isAccessDeniedError(notFound)).toBe(false);
    expect(isAccessDeniedError(validation)).toBe(false);
    expect(isAccessDeniedError(conflict)).toBe(false);
    expect(isAccessDeniedError(locked)).toBe(false);
    expect(isAccessDeniedError(rateLimited)).toBe(false);
    expect(isAccessDeniedError(plain)).toBe(false);
    expect(isAccessDeniedError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// name property
// ---------------------------------------------------------------------------

describe('Error name property', () => {
  it('NotFoundError.name is NotFoundError', () => {
    expect(new NotFoundError('t', 'id').name).toBe('NotFoundError');
  });

  it('ValidationError.name is ValidationError', () => {
    expect(new ValidationError('f', 'm').name).toBe('ValidationError');
  });

  it('ConflictError.name is ConflictError', () => {
    expect(new ConflictError('r', 'm').name).toBe('ConflictError');
  });

  it('EncryptionLockedError.name is EncryptionLockedError', () => {
    expect(new EncryptionLockedError().name).toBe('EncryptionLockedError');
  });

  it('RateLimitedError.name is RateLimitedError', () => {
    expect(new RateLimitedError(10).name).toBe('RateLimitedError');
  });

  it('AccessDeniedError.name is AccessDeniedError', () => {
    expect(new AccessDeniedError('r', 'm').name).toBe('AccessDeniedError');
  });
});
