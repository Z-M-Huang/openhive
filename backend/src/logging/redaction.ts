/**
 * OpenHive Backend - Log Field Redaction
 *
 * Implements sensitive field redaction for log entries:
 *   - Sensitive field list (api_key, master_key, oauth_token, token,
 *     authorization, secrets)
 *   - Recursive JSON walk with case-insensitive key matching
 *   - String pattern replacement for KEY=value env-var-style entries
 */

import type { JsonValue } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The placeholder value written in place of a sensitive field's value. */
const REDACTED = '[REDACTED]';

/** The set of JSON key names whose values must be redacted, stored lowercase. */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'api_key',
  'master_key',
  'oauth_token',
  'token',
  'authorization',
  'secrets',
]);

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

/**
 * Handles sensitive field redaction in log entries.
 *
 * The sensitive field list is fixed at construction time.
 */
export class Redactor {
  private readonly fields: ReadonlySet<string>;

  constructor(fields: ReadonlySet<string> = SENSITIVE_FIELDS) {
    this.fields = fields;
  }

  // -------------------------------------------------------------------------
  // redactParams
  // -------------------------------------------------------------------------

  /**
   * Parses a JSON string, recursively walks the value tree, and replaces
   * the values of sensitive keys with "[REDACTED]". Returns the re-serialized
   * JSON string.
   *
   * If `raw` is empty or cannot be parsed as JSON, it is returned unchanged.
   */
  redactParams(raw: string): string {
    if (raw.length === 0) {
      return raw;
    }

    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw) as JsonValue;
    } catch {
      // Not valid JSON — return unchanged (same as Go behaviour)
      return raw;
    }

    const redacted = this.redactValue(parsed);

    try {
      return JSON.stringify(redacted);
    } catch {
      return raw;
    }
  }

  // -------------------------------------------------------------------------
  // redactString
  // -------------------------------------------------------------------------

  /**
   * Scans `s` for env-var-style patterns of the form `FIELD=value` (where
   * FIELD is an uppercased sensitive field name) and replaces the value
   * portion with "[REDACTED]".
   *
   * Replacement stops at the next space character (or end-of-string).
   */
  redactString(s: string): string {
    let result = s;
    for (const field of this.fields) {
      const upper = field.toUpperCase();
      const marker = upper + '=';
      const idx = result.indexOf(marker);
      if (idx === -1) {
        continue;
      }
      const valueStart = idx + marker.length;
      const spaceIdx = result.indexOf(' ', valueStart);
      if (spaceIdx === -1) {
        // Value extends to end of string
        result = result.slice(0, valueStart) + REDACTED;
      } else {
        // Value ends at the next space
        result = result.slice(0, valueStart) + REDACTED + result.slice(spaceIdx);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Recursively redacts sensitive values within a JsonValue tree.
   *
   * - Objects: if a key (lowercased) is in the sensitive set, replace its
   *   value with "[REDACTED]"; otherwise recurse into the value.
   * - Arrays: recurse into each element.
   * - Primitives: return unchanged.
   */
  private redactValue(v: JsonValue): JsonValue {
    if (Array.isArray(v)) {
      return v.map((item) => this.redactValue(item));
    }

    if (v !== null && typeof v === 'object') {
      const result: { [key: string]: JsonValue } = {};
      for (const [k, val] of Object.entries(v)) {
        if (this.fields.has(k.toLowerCase())) {
          result[k] = REDACTED;
        } else {
          result[k] = this.redactValue(val);
        }
      }
      return result;
    }

    // Primitive (string, number, boolean, null) — return unchanged
    return v;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Creates a new Redactor with the default sensitive field list. */
export function newRedactor(): Redactor {
  return new Redactor();
}
