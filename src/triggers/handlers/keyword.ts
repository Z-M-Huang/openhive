/**
 * Keyword trigger handler -- matches text against a keyword pattern.
 *
 * Pattern can be a plain string (case-insensitive substring match)
 * or a regex string prefixed with "/" (e.g. "/deploy\\s+v\\d+/i").
 */

import type { TriggerConfig } from '../../domain/types.js';

export class KeywordHandler {
  private readonly regex: RegExp;

  /** The associated trigger config, set by the engine after construction. */
  trigger!: TriggerConfig;

  constructor(
    pattern: string,
    readonly callback: () => void,
  ) {
    if (pattern.startsWith('/')) {
      const last = pattern.lastIndexOf('/');
      const body = pattern.slice(1, last);
      const flags = pattern.slice(last + 1);
      this.regex = new RegExp(body, flags);
    } else {
      this.regex = new RegExp(escapeRegex(pattern), 'i');
    }
  }

  match(text: string): boolean {
    return this.regex.test(text);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
