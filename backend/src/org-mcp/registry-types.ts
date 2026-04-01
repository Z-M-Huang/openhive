/**
 * Org-MCP registry types — narrowed dependency types and shared utilities.
 *
 * Extracted from registry.ts to keep the main registry under the 300-line cap.
 */

import type { z } from 'zod';
import type { OrgMcpDeps } from './registry.js';
import type { ITaskQueueStore } from '../domain/interfaces.js';

// ── Narrowed dep types — compile-time enforcement that each tool
//    only receives the OrgMcpDeps fields it actually needs. ──────────

export type ShutdownTeamOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'sessionManager' | 'taskQueue' | 'runDir'> & {
  readonly triggerEngine?: OrgMcpDeps['triggerEngine'];
  readonly triggerConfigStore?: OrgMcpDeps['triggerConfigStore'];
  readonly escalationStore?: OrgMcpDeps['escalationStore'];
  readonly interactionStore?: OrgMcpDeps['interactionStore'];
};
export type DelegateTaskOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'taskQueue' | 'log'>;
export type EscalateOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'escalationStore' | 'taskQueue'>;
export type SendMessageOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'log'>;
export type GetStatusOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'taskQueue'>;
export type ListTeamsOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'taskQueue' | 'getTeamConfig'>;
export type QueryTeamOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'getTeamConfig' | 'log'> & {
  readonly queryRunner?: OrgMcpDeps['queryRunner'];
};
export type BrowserToolOrgDeps = Pick<OrgMcpDeps, 'getTeamConfig'> & {
  readonly browserRelay: NonNullable<OrgMcpDeps['browserRelay']>;
};

// ── Tool definition type ────────────────────────────────────────────

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly handler: (input: unknown, callerId: string, sourceChannelId?: string) => Promise<unknown>;
}

// ── Scoped queue utility ────────────────────────────────────────────

/** Wraps a task queue to auto-inject sourceChannelId into options JSON.
 *  Only enqueue() is overridden; all other methods pass through via prototype. */
export function scopeQueue(queue: ITaskQueueStore, channelId?: string): ITaskQueueStore {
  if (!channelId) return queue;
  const enqueue: ITaskQueueStore['enqueue'] = (teamId, task, priority, correlationId?, options?) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = options ? JSON.parse(options) as Record<string, unknown> : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) parsed = {};
    } catch { parsed = {}; }
    parsed.sourceChannelId = channelId;
    return queue.enqueue(teamId, task, priority, correlationId, JSON.stringify(parsed));
  };
  return Object.assign(Object.create(queue) as ITaskQueueStore, { enqueue });
}
