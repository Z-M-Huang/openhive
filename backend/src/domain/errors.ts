/**
 * Domain error hierarchy for OpenHive v3.
 *
 * All domain errors extend OpenHiveError so callers can catch
 * a single base class when they don't care about the specific kind.
 */

export class OpenHiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenHiveError';
  }
}

export class ConfigError extends OpenHiveError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ValidationError extends OpenHiveError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ScopeRejectionError extends OpenHiveError {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeRejectionError';
  }
}

export class WorkspaceBoundaryError extends OpenHiveError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
  }
}

export class SecretLeakError extends OpenHiveError {
  constructor(message: string) {
    super(message);
    this.name = 'SecretLeakError';
  }
}
