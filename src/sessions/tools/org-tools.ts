/**
 * Inline org tool builders — wraps 11 handler functions as AI SDK inline defs.
 *
 * Each tool uses bare names (e.g. "spawn_team").
 * Tools are returned in alphabetical order. The query_team / query_teams tools
 * are conditionally included only when ctx.queryRunner is defined.
 * enqueue_parent_task is unconditional — non-root callers only.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { OrgToolContext } from './org-tool-context.js';
import type { IOrgStore } from '../../domain/interfaces.js';

import { DelegateTaskInputSchema, delegateTask } from '../../handlers/tools/delegate-task.js';
import { EnqueueParentTaskInputSchema, enqueueParentTask } from '../../handlers/tools/enqueue-parent-task.js';
import { EscalateInputSchema, escalate } from '../../handlers/tools/escalate.js';
import { GetStatusInputSchema, getStatus } from '../../handlers/tools/get-status.js';
import { ListCompletedTasksInputSchema, listCompletedTasks } from '../../handlers/tools/list-completed-tasks.js';
import { ListTeamsInputSchema, listTeams } from '../../handlers/tools/list-teams.js';
import { QueryTeamInputSchema, queryTeam } from '../../handlers/tools/query-team.js';
import { QueryTeamsInputSchema, queryTeams } from '../../handlers/tools/query-teams.js';
import { SendMessageInputSchema, sendMessage } from '../../handlers/tools/send-message.js';
import { ShutdownTeamInputSchema, shutdownTeam } from '../../handlers/tools/shutdown-team.js';
import { SpawnTeamInputSchema, spawnTeam } from '../../handlers/tools/spawn-team.js';
import { UpdateTeamInputSchema, updateTeam } from '../../handlers/tools/update-team.js';
import { AddTrustedSenderInputSchema, addTrustedSender } from '../../handlers/tools/add-trusted-sender.js';
import { RevokeSenderTrustInputSchema, revokeSenderTrust } from '../../handlers/tools/revoke-sender-trust.js';
import { ListTrustedSendersInputSchema, listTrustedSenders } from '../../handlers/tools/list-trusted-senders.js';
import { RegisterPluginToolInputSchema, registerPluginTool } from '../../handlers/tools/register-plugin-tool.js';

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the 12 org tools as AI SDK inline tool definitions.
 * Returns a ToolSet keyed by bare tool name, sorted alphabetically.
 * `query_team` / `query_teams` are conditional on `ctx.queryRunner`.
 * Baseline (queryRunner undefined) = 10 tools; with queryRunner = 12.
 */
// eslint-disable-next-line max-lines-per-function -- Tool registry enumerates 10+ org tools inline; refactor would scatter the toolset definition.
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

  // 2. enqueue_parent_task (ADR-43: work handoff to parent)
  tools['enqueue_parent_task'] = tool({
    description:
      'Enqueue a work-handoff task to the parent team. ' +
      'Rate-capped to 5/min per caller with 5-minute correlation-id dedup. ' +
      'For notification-only alerts to the parent, use escalate instead.',
    inputSchema: EnqueueParentTaskInputSchema,
    execute: async (input) =>
      enqueueParentTask(input, ctx.teamName, {
        taskQueue: ctx.taskQueue,
        orgTree: ctx.orgTree,
      }, ctx.sourceChannelId),
  });

  // 3. escalate
  tools['escalate'] = tool({
    description:
      'Notification-only upward path: sends an alert to the parent team. ' +
      'For work handoff to the parent, use enqueue_parent_task instead.',
    inputSchema: EscalateInputSchema,
    execute: async (input) =>
      escalate(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        escalationStore: ctx.escalationStore,
        taskQueue: ctx.taskQueue,
      }, ctx.sourceChannelId),
  });

  // 3. get_status
  tools['get_status'] = tool({
    description: 'Get status of child teams. Returns the wiki-defined shape per team: {active_daily_ops, saturation, org_op_pending, queue_depth, current_task?, pending_tasks[]} (ADR-41, Organization-Tools §get_status).',
    inputSchema: GetStatusInputSchema,
    execute: async (input) =>
      getStatus(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        taskQueue: ctx.taskQueue,
        concurrencyManager: ctx.concurrencyManager,
      }),
  });

  // 5. list_completed_tasks
  tools['list_completed_tasks'] = tool({
    description: 'List recent completed (done/failed) tasks for a team',
    inputSchema: ListCompletedTasksInputSchema,
    execute: async (input) =>
      listCompletedTasks(input, ctx.teamName, {
        taskQueue: ctx.taskQueue,
      }),
  });

  // 6. list_teams
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

  // 6. query_team / query_teams (conditional — both require queryRunner)
  if (ctx.queryRunner) {
    const runner = ctx.queryRunner;
    // R11c: caller-side credentials feed query_teams aggregate scrubbing (AC-24).
    // Re-resolved per call so rotated secrets are picked up immediately.
    const credentialsLookup = (): readonly string[] => {
      const entries = ctx.vaultStore?.getSecrets(ctx.teamName) ?? [];
      return entries.map((e) => e.value).filter((v) => v.length >= 8);
    };
    tools['query_team'] = tool({
      description:
        'Synchronously query a single child team and return its response. ' +
        'For querying multiple teams in parallel use query_teams; ' +
        'for fire-and-forget multi-team tasks use delegate_task.',
      inputSchema: QueryTeamInputSchema,
      execute: async (input) =>
        queryTeam(input, ctx.teamName, {
          orgTree: ctx.orgTree,
          getTeamConfig: ctx.getTeamConfig,
          vaultStore: ctx.vaultStore,
          queryRunner: runner,
          log: ctx.log,
        }, ctx.sourceChannelId),
    });

    tools['query_teams'] = tool({
      description:
        'Fan-out a query to multiple direct-child teams in parallel and collect their responses. ' +
        'For a single-team synchronous query use query_team; ' +
        'for fire-and-forget tasks use delegate_task.',
      inputSchema: QueryTeamsInputSchema,
      execute: async (input) =>
        queryTeams(input, ctx.teamName, {
          queryRunner: runner,
          queryTeamHandler: async ({ team, query }) => {
            const r = await queryTeam(
              { team, query },
              ctx.teamName,
              {
                orgTree: ctx.orgTree,
                getTeamConfig: ctx.getTeamConfig,
                vaultStore: ctx.vaultStore,
                queryRunner: runner,
                log: ctx.log,
              },
              ctx.sourceChannelId,
            );
            return { success: r.success, result: r.response, error: r.error };
          },
          // OrgTree implements the getTeam/getChildren subset needed by queryTeams;
          // cast to IOrgStore to satisfy the handler's interface contract.
          orgTree: ctx.orgTree as unknown as IOrgStore,
          credentialsLookup,
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
    description:
      'Create a new child team and spawn its session. ' +
      'Always echo the message_for_user field back to the user or channel verbatim — ' +
      'do not fabricate progress or completion status.',
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

  // ── Plugin tools ───────────────────────────────────────────────────────────
  if (ctx.pluginToolStore) {
    tools['register_plugin_tool'] = tool({
      description: 'Register a new plugin tool for this team',
      inputSchema: RegisterPluginToolInputSchema,
      execute: async (input) =>
        registerPluginTool(input, ctx.teamName, {
          pluginToolStore: ctx.pluginToolStore!,
          runDir: ctx.runDir,
          log: ctx.log,
        }),
    });
  }

  return tools;
}
