/**
 * OpenHive Backend - Domain Errors
 *
 * Each error class extends Error with a code getter.
 * Message formats ensure API/WebSocket protocol compatibility.
 */

// ---------------------------------------------------------------------------
// NotFoundError
// ---------------------------------------------------------------------------

/**
 * Thrown when a requested resource does not exist.
 * Message format: "{resource} not found: {id}"
 */
export class NotFoundError extends Error {
  readonly resource: string;
  readonly id: string;

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = 'NotFoundError';
    this.resource = resource;
    this.id = id;
    // Restore prototype chain (required when extending built-ins in TypeScript)
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }

  get code(): 'NOT_FOUND' {
    return 'NOT_FOUND';
  }
}

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

/**
 * Thrown when input validation fails.
 * Message format (with field):    "validation error on {field}: {message}"
 * Message format (without field): "validation error: {message}"
 */
export class ValidationError extends Error {
  readonly field: string;
  readonly validationMessage: string;

  constructor(field: string, message: string) {
    const formatted =
      field !== ''
        ? `validation error on ${field}: ${message}`
        : `validation error: ${message}`;
    super(formatted);
    this.name = 'ValidationError';
    this.field = field;
    this.validationMessage = message;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }

  get code(): 'VALIDATION_ERROR' {
    return 'VALIDATION_ERROR';
  }
}

// ---------------------------------------------------------------------------
// ConflictError
// ---------------------------------------------------------------------------

/**
 * Thrown when an operation conflicts with existing state.
 * Message format: "conflict on {resource}: {message}"
 */
export class ConflictError extends Error {
  readonly resource: string;
  readonly conflictMessage: string;

  constructor(resource: string, message: string) {
    super(`conflict on ${resource}: ${message}`);
    this.name = 'ConflictError';
    this.resource = resource;
    this.conflictMessage = message;
    Object.setPrototypeOf(this, ConflictError.prototype);
  }

  get code(): 'CONFLICT' {
    return 'CONFLICT';
  }
}

// ---------------------------------------------------------------------------
// EncryptionLockedError
// ---------------------------------------------------------------------------

/**
 * Thrown when encryption operations are attempted while the key manager is
 * in a locked state.
 * Message format (with message):    "encryption locked: {message}"
 * Message format (without message): "encryption locked: master key not set"
 */
export class EncryptionLockedError extends Error {
  readonly lockMessage: string;

  constructor(message?: string) {
    const resolved = message !== undefined && message !== '' ? message : 'master key not set';
    super(`encryption locked: ${resolved}`);
    this.name = 'EncryptionLockedError';
    this.lockMessage = resolved;
    Object.setPrototypeOf(this, EncryptionLockedError.prototype);
  }

  get code(): 'ENCRYPTION_LOCKED' {
    return 'ENCRYPTION_LOCKED';
  }
}

// ---------------------------------------------------------------------------
// RateLimitedError
// ---------------------------------------------------------------------------

/**
 * Thrown when a rate limit is exceeded.
 * Message format: "rate limited: retry after {n} seconds"
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`rate limited: retry after ${retryAfterSeconds} seconds`);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, RateLimitedError.prototype);
  }

  get code(): 'RATE_LIMITED' {
    return 'RATE_LIMITED';
  }
}

// ---------------------------------------------------------------------------
// AccessDeniedError
// ---------------------------------------------------------------------------

/**
 * Thrown when an operation is not authorized.
 * Message format (with resource):    "access denied on {resource}: {message}"
 * Message format (without resource): "access denied: {message}"
 */
export class AccessDeniedError extends Error {
  readonly resource: string;
  readonly denialMessage: string;

  constructor(resource: string, message: string) {
    const formatted =
      resource !== ''
        ? `access denied on ${resource}: ${message}`
        : `access denied: ${message}`;
    super(formatted);
    this.name = 'AccessDeniedError';
    this.resource = resource;
    this.denialMessage = message;
    Object.setPrototypeOf(this, AccessDeniedError.prototype);
  }

  get code(): 'ACCESS_DENIED' {
    return 'ACCESS_DENIED';
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true if the value is a NotFoundError instance. */
export function isNotFoundError(value: unknown): value is NotFoundError {
  return value instanceof NotFoundError;
}

/** Returns true if the value is a ValidationError instance. */
export function isValidationError(value: unknown): value is ValidationError {
  return value instanceof ValidationError;
}

/** Returns true if the value is a ConflictError instance. */
export function isConflictError(value: unknown): value is ConflictError {
  return value instanceof ConflictError;
}

/** Returns true if the value is an EncryptionLockedError instance. */
export function isEncryptionLockedError(value: unknown): value is EncryptionLockedError {
  return value instanceof EncryptionLockedError;
}

/** Returns true if the value is a RateLimitedError instance. */
export function isRateLimitedError(value: unknown): value is RateLimitedError {
  return value instanceof RateLimitedError;
}

/** Returns true if the value is an AccessDeniedError instance. */
export function isAccessDeniedError(value: unknown): value is AccessDeniedError {
  return value instanceof AccessDeniedError;
}

// ---------------------------------------------------------------------------
// Union type — all domain errors
// ---------------------------------------------------------------------------

/** Union of all domain error types. */
export type DomainError =
  | NotFoundError
  | ValidationError
  | ConflictError
  | EncryptionLockedError
  | RateLimitedError
  | AccessDeniedError;
