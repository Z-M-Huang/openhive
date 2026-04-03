/**
 * get_credential tool — retrieve a credential value on demand.
 *
 * Replaces always-on system prompt credential injection.
 * The agent calls this tool only when it actually needs a credential value,
 * providing an audit trail and reducing exposure.
 */

import { z } from 'zod';
import type { TeamConfig } from '../../domain/types.js';

export const GetCredentialInputSchema = z.object({
  key: z.string().min(1).describe('The credential key to retrieve (e.g., "api_key", "subdomain")'),
});

export type GetCredentialInput = z.infer<typeof GetCredentialInputSchema>;

export interface GetCredentialResult {
  readonly success: boolean;
  readonly value?: string;
  readonly error?: string;
  readonly note?: string;
}

export interface GetCredentialDeps {
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function getCredential(
  input: GetCredentialInput,
  callerId: string,
  deps: GetCredentialDeps,
): GetCredentialResult {
  const parsed = GetCredentialInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const config = deps.getTeamConfig(callerId);
  if (!config) {
    return { success: false, error: 'team not found' };
  }

  const value = config.credentials?.[parsed.data.key];
  if (value === undefined) {
    return { success: false, error: `credential "${parsed.data.key}" not found` };
  }

  deps.log('credential_access', { team: callerId, key: parsed.data.key });

  return {
    success: true,
    value,
    note: 'Use this value only in API calls. Do NOT store it in files, memory, or task results.',
  };
}
