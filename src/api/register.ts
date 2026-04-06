/**
 * Centralized API route registration.
 *
 * Registers all /api/v1/* routes in the correct order.
 * CRITICAL: tasks/stats is registered before tasks/:id inside registerTasksRoutes().
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { OrgTree } from '../domain/org-tree.js';
import type { ITaskQueueStore, ITriggerConfigStore } from '../domain/interfaces.js';
import { registerOverviewRoute } from './overview.js';
import { registerTeamsRoutes } from './teams.js';
import { registerTasksRoutes } from './tasks.js';
import { registerLogsRoutes } from './logs.js';
import { registerMemoriesRoutes } from './memories.js';
import { registerTriggersRoutes } from './triggers.js';
import { registerTopicsRoutes } from './topics.js';
import { registerInteractionsRoutes } from './interactions.js';

export interface DashboardDeps {
  readonly raw: Database.Database;
  readonly orgTree: OrgTree;
  readonly taskQueueStore: ITaskQueueStore;
  readonly triggerConfigStore: ITriggerConfigStore;
}

/**
 * Register all API routes on the Fastify instance.
 *
 * Order matters: overview first (no params), then teams (has :name param),
 * then tasks (stats before :id — handled internally by registerTasksRoutes).
 */
export function registerApiRoutes(fastify: FastifyInstance, deps: DashboardDeps): void {
  registerOverviewRoute(fastify, { raw: deps.raw, orgTree: deps.orgTree, taskQueueStore: deps.taskQueueStore, triggerConfigStore: deps.triggerConfigStore });
  registerTeamsRoutes(fastify, { raw: deps.raw, orgTree: deps.orgTree, taskQueueStore: deps.taskQueueStore });
  registerTasksRoutes(fastify, { raw: deps.raw });
  registerLogsRoutes(fastify, { raw: deps.raw });
  registerMemoriesRoutes(fastify, { raw: deps.raw });
  registerTriggersRoutes(fastify, { raw: deps.raw, triggerConfigStore: deps.triggerConfigStore });
  registerTopicsRoutes(fastify, { raw: deps.raw });
  registerInteractionsRoutes(fastify, { raw: deps.raw });
}
