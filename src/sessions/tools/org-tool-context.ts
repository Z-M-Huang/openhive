/**
 * OrgToolContext — interface-first dependency bag for org tool builders.
 *
 * Replaces the concrete-class-based OrgToolDeps from handlers/tool-invoker.ts.
 * All fields use domain interfaces (ITaskQueueStore, IEscalationStore, etc.)
 * rather than concrete classes, enabling straightforward testing and
 * decoupling tool builders from transport.
 */

import type { OrgTree } from '../../domain/org-tree.js';
import type { TeamConfig, TriggerConfig } from '../../domain/types.js';
import type {
  ISessionSpawner,
  ISessionManager,
  ITaskQueueStore,
  IEscalationStore,
  ITriggerConfigStore,
  IInteractionStore,
  IMemoryStore,
  ISenderTrustStore,
  IVaultStore,
} from '../../domain/interfaces.js';

// ── Narrow interfaces for concrete deps not yet in domain/interfaces ─────

/** Minimal interface for TriggerEngine — only the methods org tools need. */
export interface ITriggerEngine {
  replaceTeamTriggers(team: string, triggers: TriggerConfig[]): void;
  removeTeamTriggers(team: string): void;
}

/** Minimal interface for BrowserRelay — only the methods org tools need. */
export interface IBrowserRelay {
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  getToolNames(): string[];
  close(): Promise<void>;
  readonly available: boolean;
}

// ── TeamQueryRunner ─────────────────────────────────────────────────────────

/** Runs a query against a child team's SDK session, returning its response. */
export type TeamQueryRunner = (
  query: string,
  team: string,
  callerId: string,
  ancestors: string[],
  sourceChannelId?: string,
) => Promise<string | void>;

// ── OrgToolContext ───────────────────────────────────────────────────────────

export interface OrgToolContext {
  readonly teamName: string;
  readonly sourceChannelId?: string;
  readonly orgTree: OrgTree;
  readonly spawner: ISessionSpawner;
  readonly sessionManager: ISessionManager;
  readonly taskQueue: ITaskQueueStore;
  readonly escalationStore: IEscalationStore;
  readonly runDir: string;
  readonly loadConfig: (name: string) => TeamConfig;
  readonly getTeamConfig: (name: string) => TeamConfig;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly queryRunner?: TeamQueryRunner;
  readonly triggerEngine?: ITriggerEngine;
  readonly triggerConfigStore?: ITriggerConfigStore;
  readonly interactionStore?: IInteractionStore;
  readonly browserRelay?: IBrowserRelay;
  readonly memoryStore?: IMemoryStore;
  readonly senderTrustStore?: ISenderTrustStore;
  readonly vaultStore?: IVaultStore;
}
