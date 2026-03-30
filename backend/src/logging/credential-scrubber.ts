/**
 * Credential scrubber — secondary defense against secret leaks in log output.
 *
 * Primary defense is SecretString at the source. This provides best-effort
 * scrubbing of known secret values and common credential patterns.
 */

import type { SecretString } from '../secrets/secret-string.js';

const REDACTED = '[REDACTED]';

/**
 * Common patterns that look like credentials.
 * Each regex is replaced globally in the input text.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,          // Anthropic/OpenAI-style API keys
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,   // Bearer tokens
  /token=[A-Za-z0-9._~+/=-]+/gi,     // token= query params
  /api[_-]?key[=:]\s*[A-Za-z0-9._~+/=-]+/gi, // api_key= or apiKey: values
];

/**
 * Scrub known secret values and common credential patterns from text.
 *
 * @param knownSecrets  SecretString instances (provider secrets)
 * @param rawSecrets    Plain string secrets (team credentials, etc.)
 */
export function scrubSecrets(
  text: string,
  knownSecrets: readonly SecretString[],
  rawSecrets?: readonly string[],
): string {
  let result = text;

  // Replace known secret values (primary — SecretString instances)
  for (const secret of knownSecrets) {
    const raw = secret.expose();
    if (raw.length === 0) continue;
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), REDACTED);
  }

  // Replace raw string secrets (team credentials)
  if (rawSecrets) {
    for (const raw of rawSecrets) {
      if (raw.length < 8) continue; // Skip short values to avoid false positives
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), REDACTED);
    }
  }

  // Replace common credential patterns (secondary)
  for (const pattern of CREDENTIAL_PATTERNS) {
    // Reset lastIndex for global regexes that may have been used before
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }

  return result;
}

/**
 * Replace credential values in `content` with `[CREDENTIAL:key]` placeholders.
 * Only credentials with values >= 8 characters are scrubbed (short values
 * produce too many false positives).
 *
 * Unlike `scrubSecrets()` which replaces with a generic `[REDACTED]`, this
 * function preserves the credential key name in the placeholder, which is
 * useful for tool output where the agent needs to know which credential
 * was present.
 *
 * Returns the (possibly modified) content string.
 */
export function scrubCredentialsFromContent(
  content: string,
  credentials: Record<string, string>,
): string {
  const entries = Object.entries(credentials).filter(([, v]) => v.length >= 8);
  if (entries.length === 0) return content;

  let scrubbed = content;
  for (const [key, value] of entries) {
    scrubbed = scrubbed.replaceAll(value, `[CREDENTIAL:${key}]`);
  }
  return scrubbed;
}

/**
 * Create a stderr scrubbing callback that replaces secrets before forwarding.
 * Returns a function suitable as a data handler for child process stderr.
 */
export function createStderrScrubber(
  knownSecrets: readonly SecretString[],
  rawSecrets?: readonly string[],
): (data: string) => void {
  return (data: string) => { process.stderr.write(scrubSecrets(data, knownSecrets, rawSecrets)); };
}
