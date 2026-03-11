/**
 * Domain error classes for OpenHive.
 *
 * Base DomainError carries a WSErrorCode. Specialized subclasses provide
 * semantic error types used throughout the codebase. The mapDomainErrorToWSError()
 * function converts any DomainError to its WSErrorCode for wire responses.
 */

import { WSErrorCode } from './enums.js';

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/** Base class for all domain errors. Carries a WSErrorCode for wire mapping. */
export class DomainError extends Error {
  readonly code: WSErrorCode;

  constructor(code: WSErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Specialized Errors
// ---------------------------------------------------------------------------

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.NotFound, message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.ValidationError, message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.Conflict, message);
    this.name = 'ConflictError';
  }
}

export class EncryptionLockedError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.EncryptionLocked, message);
    this.name = 'EncryptionLockedError';
  }
}

export class RateLimitedError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.RateLimited, message);
    this.name = 'RateLimitedError';
  }
}

export class AccessDeniedError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.AccessDenied, message);
    this.name = 'AccessDeniedError';
  }
}

export class InternalError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.InternalError, message);
    this.name = 'InternalError';
  }
}

export class DepthLimitExceededError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.DepthLimitExceeded, message);
    this.name = 'DepthLimitExceededError';
  }
}

export class CycleDetectedError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.CycleDetected, message);
    this.name = 'CycleDetectedError';
  }
}

/** Thrown when a task state transition violates the state machine. */
export class InvalidTransitionError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.ValidationError, message);
    this.name = 'InvalidTransitionError';
  }
}

/** Thrown when an AID or TID does not match the expected format. */
export class InvalidIDError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.ValidationError, message);
    this.name = 'InvalidIDError';
  }
}

/** Thrown when a team slug matches a reserved name. */
export class ReservedSlugError extends DomainError {
  constructor(message: string) {
    super(WSErrorCode.ValidationError, message);
    this.name = 'ReservedSlugError';
  }
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/** Maps a DomainError to its WSErrorCode for wire-protocol responses. */
export function mapDomainErrorToWSError(err: DomainError): WSErrorCode {
  return err.code;
}
