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

  handlers.set('set_credential', async (args, agentAid, teamSlug) => {
    const parsed = SetCredentialSchema.parse(args);

    // Determine target team: explicit team_slug (cross-team) or caller's team
    let targetTeam = teamSlug;
    if (parsed.team_slug && parsed.team_slug !== teamSlug) {
      // Only main_assistant can store credentials for other teams
      const callerAgent = ctx.orgChart.getAgent(agentAid);
      if (callerAgent?.role !== 'main_assistant') {
        throw new Error(`Unauthorized: only main_assistant can set credentials for other teams (attempted: '${parsed.team_slug}')`);
      }
      // Verify target team exists
      const targetTeamEntry = ctx.orgChart.getTeamBySlug(parsed.team_slug);
      if (!targetTeamEntry) {
        throw new NotFoundError(`Target team '${parsed.team_slug}' not found`);
      }
      targetTeam = parsed.team_slug;
    }

    await ctx.credentialStore.create({
      id: crypto.randomUUID(),
      name: parsed.key,
      encrypted_value: parsed.value,
      team_id: targetTeam,
      created_at: Date.now(),
    });

    return { message: `Credential '${parsed.key}' stored for team '${targetTeam}'` };
  });

  return handlers;
}
