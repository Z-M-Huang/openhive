/**
 * Redaction module — pure-function sensitive data redaction.
 *
 * Provides two redaction functions:
 * - redactParams(): deep-walks objects, replacing sensitive key values with '[REDACTED]'
 * - redactMessage(): scans log message strings for KEY=value patterns
 *
 * Sensitive keys sourced from NFR09 (logger.ts JSDoc + wiki).
 */

/** Set of sensitive key names (lowercase) for O(1) lookup. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'api_key',
  'master_key',
  'oauth_token',
  'token',
  'authorization',
  'secrets',
  'password',
  'credential',
  'private_key',
  'access_token',
  'refresh_token',
  'bearer',
  'connection_string',
]);

const REDACTED = '[REDACTED]';

/**
 * Build regex pattern for message redaction.
 * Matches: sensitive_key followed by = or : then a non-whitespace value.
 */
const MESSAGE_PATTERN = new RegExp(
  `(\\b(?:${[...SENSITIVE_KEYS].join('|')})\\s*[=:]\\s*)(\\S+)`,
  'gi',
);

/**
 * Deep-walk an object and replace values of sensitive keys with '[REDACTED]'.
 *
 * - Keys are matched case-insensitively against SENSITIVE_KEYS.
 * - Nested objects are recursively walked.
 * - Arrays are mapped element-by-element.
 * - Non-object/non-array values are returned unchanged.
 */
export function redactParams(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  return redactObject(obj) as Record<string, unknown>;
}

function redactObject(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = redactObject(val);
      }
    }
    return result;
  }

  return value;
}

/**
 * Scan a log message string for KEY=value or KEY:value patterns
 * where KEY is a sensitive key, and replace the value with [REDACTED].
 */
export function redactMessage(message: string): string {
  if (!message) {
    return message;
  }
  // Reset lastIndex since the regex has the global flag
  MESSAGE_PATTERN.lastIndex = 0;
  return message.replace(MESSAGE_PATTERN, `$1${REDACTED}`);
}
