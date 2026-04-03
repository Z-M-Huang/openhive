/**
 * Safe JSON parsing utility.
 *
 * Returns `T | undefined` instead of throwing on malformed input,
 * logging a warning so the caller can decide how to handle the failure.
 */

import { errorMessage } from './errors.js';

export function safeJsonParse<T>(input: unknown, context?: string): T | undefined {
  if (typeof input !== 'string') {
    console.error(`[safeJsonParse] Expected string${context ? ` (${context})` : ''}, got ${typeof input}`);
    return undefined;
  }
  try {
    return JSON.parse(input) as T;
  } catch (err) {
    console.error(`[safeJsonParse] Failed to parse${context ? ` (${context})` : ''}:`, errorMessage(err));
    return undefined;
  }
}
