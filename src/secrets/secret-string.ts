/**
 * Immutable wrapper for secret string values.
 *
 * Prevents accidental leaking via toString, JSON.stringify, console.log, etc.
 * Use .expose() for intentional access to the raw value.
 */

import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  /** Intentional access to the raw secret value. */
  expose(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

Object.freeze(SecretString.prototype);
