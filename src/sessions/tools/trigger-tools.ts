/**
 * Inline trigger tool builders — wraps 6 trigger handlers as AI SDK inline defs.
 *
 * Each tool uses bare names (e.g. "create_trigger").
 * Tools are returned in alphabetical order.
 * Returns empty `{}` when `ctx.triggerConfigStore` is undefined.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { OrgToolContext } from './org-tool-context.js';

import { CreateTriggerInputSchema, createTrigger } from '../../handlers/tools/create-trigger.js';
import { loadSubagents } from '../skill-loader.js';
import { DisableTriggerInputSchema, disableTrigger, type DisableTriggerDeps } from '../../handlers/tools/disable-trigger.js';
import { EnableTriggerInputSchema, enableTrigger, type EnableTriggerDeps } from '../../handlers/tools/enable-trigger.js';
import { ListTriggersInputSchema, listTriggers } from '../../handlers/tools/list-triggers.js';
import { TestTriggerInputSchema, testTrigger } from '../../handlers/tools/test-trigger.js';
import { UpdateTriggerInputSchema, updateTrigger, type UpdateTriggerDeps } from '../../handlers/tools/update-trigger.js';

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the 6 trigger tools as AI SDK inline tool definitions.
 * Returns a ToolSet keyed by bare tool name, sorted alphabetically.
 * Returns empty `{}` when `ctx.triggerConfigStore` is undefined.
 */
export function buildTriggerTools(ctx: OrgToolContext): ToolSet {
  if (!ctx.triggerConfigStore) return {};

  const configStore = ctx.triggerConfigStore;
  const tools: ToolSet = {};

  // 1. create_trigger
  tools['create_trigger'] = tool({
    description:
      'Create a new trigger in pending state for a child team. ' +
      'Pass `subagent` to route fired tasks to a specific subagent defined under the team.',
    inputSchema: CreateTriggerInputSchema,
    execute: async (input) =>
      createTrigger(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        configStore,
        runDir: ctx.runDir,
        loadSubagents,
        log: ctx.log,
      }, ctx.sourceChannelId),
  });

  // 2. disable_trigger
  tools['disable_trigger'] = tool({
    description: 'Deactivate a trigger and unregister its handler',
    inputSchema: DisableTriggerInputSchema,
    execute: async (input) => {
      if (!ctx.triggerEngine) return { success: false, error: 'trigger engine not available' };
      // Cast: ITriggerEngine is structurally compatible with concrete TriggerEngine
      // for the methods the handler uses (replaceTeamTriggers, removeTeamTriggers)
      return disableTrigger(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        configStore,
        triggerEngine: ctx.triggerEngine as DisableTriggerDeps['triggerEngine'],
        log: ctx.log,
      });
    },
  });

  // 3. enable_trigger
  tools['enable_trigger'] = tool({
    description: 'Activate a pending or disabled trigger and register its handler',
    inputSchema: EnableTriggerInputSchema,
    execute: async (input) => {
      if (!ctx.triggerEngine) return { success: false, error: 'trigger engine not available' };
      return enableTrigger(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        configStore,
        triggerEngine: ctx.triggerEngine as EnableTriggerDeps['triggerEngine'],
        log: ctx.log,
      });
    },
  });

  // 4. list_triggers
  tools['list_triggers'] = tool({
    description:
      'List all triggers and their states for a team. ' +
      'Each result includes `subagent` showing which subagent (if any) handles the trigger.',
    inputSchema: ListTriggersInputSchema,
    execute: async (input) =>
      listTriggers(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        configStore,
      }),
  });

  // 5. test_trigger
  tools['test_trigger'] = tool({
    description: 'Fire a trigger once for testing without changing its state. Supports max_steps override.',
    inputSchema: TestTriggerInputSchema,
    execute: async (input) =>
      testTrigger(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        configStore,
        taskQueue: ctx.taskQueue,
        log: ctx.log,
      }, ctx.sourceChannelId),
  });

  // 6. update_trigger
  tools['update_trigger'] = tool({
    description:
      'Update trigger config, task, or settings. ' +
      'Pass `subagent` to change routing; omit it to preserve the existing subagent.',
    inputSchema: UpdateTriggerInputSchema,
    execute: async (input) => {
      if (!ctx.triggerEngine) return { success: false, error: 'trigger engine not available' };
      return updateTrigger(input, ctx.teamName, {
        orgTree: ctx.orgTree,
        configStore,
        triggerEngine: ctx.triggerEngine as UpdateTriggerDeps['triggerEngine'],
        runDir: ctx.runDir,
        loadSubagents,
        log: ctx.log,
      });
    },
  });

  return tools;
}
