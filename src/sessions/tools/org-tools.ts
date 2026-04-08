/**
 * Inline org tool builders — wraps 10 handler functions as AI SDK inline defs.
 *
 * Each tool uses bare names (e.g. "spawn_team", not "mcp__org__spawn_team").
 * Tools are returned in alphabetical order. The query_team tool is
 * conditionally included only when ctx.queryRunner is defined.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { OrgToolContext } from './org-tool-context.js';

import { DelegateTaskInputSchema, delegateTask } from '../../handlers/tools/delegate-task.js';
import { EscalateInputSchema, escalate } from '../../handlers/tools/escalate.js';
import { GetCredentialInputSchema, getCredential } from '../../handlers/tools/get-credential.js';
import { GetStatusInputSchema, getStatus } from '../../handlers/tools/get-status.js';
import { ListTeamsInputSchema, listTeams } from '../../handlers/tools/list-teams.js';
import { QueryTeamInputSchema, queryTeam } from '../../handlers/tools/query-team.js';
import { SendMessageInputSchema, sendMessage } from '../../handlers/tools/send-message.js';
import { ShutdownTeamInputSchema, shutdownTeam } from '../../handlers/tools/shutdown-team.js';
import { SpawnTeamInputSchema, spawnTeam } from '../../handlers/tools/spawn-team.js';
import { UpdateTeamInputSchema, updateTeam } from '../../handlers/tools/update-team.js';
import { AddTrustedSenderInputSchema, addTrustedSender } from '../../handlers/tools/add-trusted-sender.js';
import { RevokeSenderTrustInputSchema, revokeSenderTrust } from '../../handlers/tools/revoke-sender-trust.js';
import { ListTrustedSendersInputSchema, listTrustedSenders } from '../../handlers/tools/list-trusted-senders.js';

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the 10 org tools as AI SDK inline tool definitions.
 * Returns a ToolSet keyed by bare tool name, sorted alphabetically.
 * `query_team` is only included when `ctx.queryRunner` is defined.
 */
export function buildOrgTools(ctx: OrgToolContext): ToolSet {
  const tools: ToolSet = {};

  // 1. delegate_task
  tools['delegate_task'] = tool({
    description: 'Delegate a task to a child team',
    inputSchema: DelegateTaskInputSchema,
    execute: async (input) =>
      delegateTask(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        taskQueue: ctx.taskQueue,
        log: ctx.log,
      }, ctx.sourceChannelId),
  });

  // 2. escalate
  tools['escalate'] = tool({
    description: 'Escalate an issue to parent team',
    inputSchema: EscalateInputSchema,
    execute: async (input) =>
      escalate(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        escalationStore: ctx.escalationStore,
        taskQueue: ctx.taskQueue,
      }, ctx.sourceChannelId),
  });

  // 3. get_credential
  tools['get_credential'] = tool({
    description:
      'Retrieve a credential value by key. Use for API calls — do NOT store returned values in files.',
    inputSchema: GetCredentialInputSchema,
    execute: async (input) =>
      getCredential(input, ctx.teamName, {
        getTeamConfig: ctx.getTeamConfig,
        log: ctx.log,
      }),
  });

  // 4. get_status
  tools['get_status'] = tool({
    description: 'Get status of child teams including queue depth',
    inputSchema: GetStatusInputSchema,
    execute: async (input) =>
      getStatus(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        taskQueue: ctx.taskQueue,
      }),
  });

  // 5. list_teams
  tools['list_teams'] = tool({
    description:
      'List child teams with descriptions, scope keywords, and status for routing decisions',
    inputSchema: ListTeamsInputSchema,
    execute: async (input) =>
      listTeams(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        taskQueue: ctx.taskQueue,
        getTeamConfig: ctx.getTeamConfig,
      }),
  });

  // 6. query_team (conditional)
  if (ctx.queryRunner) {
    const runner = ctx.queryRunner;
    tools['query_team'] = tool({
      description: 'Synchronously query a child team and return its response',
      inputSchema: QueryTeamInputSchema,
      execute: async (input) =>
        queryTeam(input, ctx.teamName, {
          orgTree: ctx.orgTree,
          getTeamConfig: ctx.getTeamConfig,
          queryRunner: runner,
          log: ctx.log,
        }, ctx.sourceChannelId),
    });
  }

  // 7. send_message
  tools['send_message'] = tool({
    description: 'Send a message to a parent or child team',
    inputSchema: SendMessageInputSchema,
    execute: async (input) =>
      sendMessage(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        log: ctx.log,
      }),
  });

  // 8. shutdown_team
  tools['shutdown_team'] = tool({
    description: 'Shut down a team, persist tasks, remove from org tree',
    inputSchema: ShutdownTeamInputSchema,
    execute: async (input) =>
      shutdownTeam(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        sessionManager: ctx.sessionManager,
        taskQueue: ctx.taskQueue,
        triggerEngine: ctx.triggerEngine,
        triggerConfigStore: ctx.triggerConfigStore,
        escalationStore: ctx.escalationStore,
        interactionStore: ctx.interactionStore,
        memoryStore: ctx.memoryStore,
        vaultStore: ctx.vaultStore,
        runDir: ctx.runDir,
      }),
  });

  // 9. spawn_team
  tools['spawn_team'] = tool({
    description: 'Create a new team and spawn its session',
    inputSchema: SpawnTeamInputSchema,
    execute: async (input) =>
      spawnTeam(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        spawner: ctx.spawner,
        runDir: ctx.runDir,
        loadConfig: ctx.loadConfig,
        taskQueue: ctx.taskQueue,
        vaultStore: ctx.vaultStore,
        triggerConfigStore: ctx.triggerConfigStore,
      }, ctx.sourceChannelId),
  });

  // 10. update_team
  tools['update_team'] = tool({
    description: 'Update a child team scope keywords',
    inputSchema: UpdateTeamInputSchema,
    execute: async (input) =>
      updateTeam(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        log: ctx.log,
      }),
  });

  // ── Trust tools (main agent only) ──────────────────────────────────────────
  if (ctx.senderTrustStore && ctx.teamName === 'main') {
    const trustDeps = { senderTrustStore: ctx.senderTrustStore };

    tools['add_trusted_sender'] = tool({
      description: 'Grant trust to a sender (stored in database)',
      inputSchema: AddTrustedSenderInputSchema,
      execute: async (input) => addTrustedSender(input, ctx.teamName, trustDeps),
    });

    tools['list_trusted_senders'] = tool({
      description: 'List trusted senders, optionally filtered by channel type',
      inputSchema: ListTrustedSendersInputSchema,
      execute: async (input) => listTrustedSenders(input, ctx.teamName, trustDeps),
    });

    tools['revoke_sender_trust'] = tool({
      description: 'Revoke a sender\'s trust (removes from database)',
      inputSchema: RevokeSenderTrustInputSchema,
      execute: async (input) => revokeSenderTrust(input, ctx.teamName, trustDeps),
    });
  }

  return tools;
}
