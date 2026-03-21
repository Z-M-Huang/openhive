/**
 * Credential tool handlers: get_credential, set_credential.
 *
 * @module mcp/tools/handlers-credential
 */

import crypto from 'node:crypto';
import { NotFoundError } from '../../domain/errors.js';
import { GetCredentialSchema, SetCredentialSchema } from './schemas.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createCredentialHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('get_credential', async (args, _agentAid, teamSlug) => {
    const parsed = GetCredentialSchema.parse(args);

    const creds = await ctx.credentialStore.listByTeam(teamSlug);
    const cred = creds.find((c) => c.name === parsed.key);
    if (!cred) {
      throw new NotFoundError(`Credential '${parsed.key}' not found for team '${teamSlug}'`);
    }

    return { value: cred.encrypted_value };
  });

  handlers.set('set_credential', async (args, _agentAid, teamSlug) => {
    const parsed = SetCredentialSchema.parse(args);

    await ctx.credentialStore.create({
      id: crypto.randomUUID(),
      name: parsed.key,
      encrypted_value: parsed.value,
      team_id: teamSlug,
      created_at: Date.now(),
    });

    return { message: `Credential '${parsed.key}' stored` };
  });

  return handlers;
}
