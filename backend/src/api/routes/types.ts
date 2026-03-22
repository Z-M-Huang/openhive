/**
 * Route context and shared schemas for API routes.
 *
 * @module api/routes/types
 */

import { z } from 'zod';
import type {
  OrgChart,
  ContainerManager,
  ContainerProvisioner,
  HealthMonitor,
  TriggerScheduler,
  Orchestrator,
  TaskStore,
  LogStore,
  TaskEventStore,
  IntegrationStore,
  CredentialStore,
  ConfigLoader,
  Logger,
  EventBus,
} from '../../domain/index.js';

/**
 * Context passed to route handlers providing access to domain services.
 */
export interface RouteContext {
  orgChart?: OrgChart;
  containerManager?: ContainerManager;
  provisioner?: ContainerProvisioner;
  healthMonitor?: HealthMonitor;
  triggerScheduler?: TriggerScheduler;
  orchestrator?: Orchestrator;
  taskStore?: TaskStore;
  logStore?: LogStore;
  taskEventStore?: TaskEventStore;
  integrationStore?: IntegrationStore;
  credentialStore?: CredentialStore;
  configLoader?: ConfigLoader;
  logger?: Logger;
  eventBus?: EventBus;
}

/** Slug regex: lowercase alphanumeric segments separated by hyphens, 3-63 chars. */
export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Zod schema for slug-format path/query params (AC-G14).
 */
export const slugSchema = z.string().regex(SLUG_REGEX).min(3).max(63);

/**
 * Reusable schema for endpoints that accept an optional ?team=<slug> query param.
 */
export const teamFilterSchema = z.object({
  team: slugSchema.optional(),
});

/**
 * Reusable schema for route params that carry a container/team slug.
 */
export const containerRestartParamsSchema = z.object({
  slug: slugSchema,
});

/** Valid task status values. */
export const TASK_STATUSES = ['pending', 'active', 'completed', 'failed', 'escalated', 'cancelled'] as const;

/** Schema for GET /api/tasks query params. */
export const taskListQuerySchema = teamFilterSchema.extend({
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/** Schema for POST /api/tasks request body. */
export const createTaskBodySchema = z.object({
  team_slug: slugSchema,
  agent_aid: z.string().optional(),
  title: z.string().min(1).max(500),
  prompt: z.string().min(1),
  priority: z.number().int().min(0).max(100).optional(),
  blocked_by: z.array(z.string()).optional(),
});

/** Schema for PATCH /api/tasks/:id request body. */
export const patchTaskBodySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

/** Schema for POST /api/teams request body. */
export const createTeamBodySchema = z.object({
  slug: slugSchema,
  coordinatorAid: z.string().optional(),
  purpose: z.string().optional(),
});

/** Schema for GET /api/logs query params. */
export const logQuerySchema = z.object({
  level: z.coerce.number().int().min(0).max(60).optional(),
  eventType: z.string().optional(),
  component: z.string().optional(),
  teamSlug: slugSchema.optional(),
  taskId: z.string().optional(),
  agentAid: z.string().optional(),
  since: z.coerce.number().int().min(0).optional(),
  until: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Duck-type helper: retrieve restart count from a container manager implementation
 * if it exposes the `getRestartCount` method.
 */
export function getRestartCount(manager: ContainerManager, slug: string): number {
  const m = manager as unknown as { getRestartCount?: (slug: string) => number };
  if (typeof m.getRestartCount === 'function') {
    return m.getRestartCount(slug);
  }
  return 0;
}
