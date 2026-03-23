/**
 * Message trigger handler -- matches text against a regex pattern
 * with an optional channel filter.
 */

import type { TriggerConfig } from '../../domain/types.js';

export class MessageHandler {
  private readonly regex: RegExp;

  /** The associated trigger config, set by the engine after construction. */
  trigger!: TriggerConfig;

  constructor(
    pattern: string,
    private readonly channelFilter: string | undefined,
    readonly callback: () => void,
  ) {
    this.regex = new RegExp(pattern);
  }

  match(text: string, channel?: string): boolean {
    if (this.channelFilter && channel !== this.channelFilter) {
      return false;
    }
    return this.regex.test(text);
  }
}
