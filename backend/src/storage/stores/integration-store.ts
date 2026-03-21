/**
 * IntegrationStore implementation.
 *
 * @module storage/stores/integration-store
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { IntegrationStore } from '../../domain/interfaces.js';
import type { Integration } from '../../domain/domain.js';
import type { IntegrationStatus } from '../../domain/enums.js';
import { NotFoundError, InvalidTransitionError } from '../../domain/errors.js';
import { VALID_INTEGRATION_TRANSITIONS } from './helpers.js';

export function newIntegrationStore(db: Database): IntegrationStore {
  return {
    async create(integration: Integration): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.integrations).values({
          id: integration.id,
          team_id: integration.team_id,
          name: integration.name,
          config_path: integration.config_path,
          status: integration.status,
          error_message: integration.error_message,
          created_at: integration.created_at,
        }).run();
      });
    },

    async get(id: string): Promise<Integration> {
      const row = db.getDB()
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Integration not found: ${id}`);
      }
      return row as Integration;
    },

    async update(integration: Integration): Promise<void> {
      const existing = db.getDB()
        .select({ id: schema.integrations.id })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integration.id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Integration not found: ${integration.id}`);
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.integrations)
          .set({
            team_id: integration.team_id,
            name: integration.name,
            config_path: integration.config_path,
            status: integration.status,
            error_message: integration.error_message,
          })
          .where(eq(schema.integrations.id, integration.id))
          .run();
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.integrations)
          .where(eq(schema.integrations.id, id))
          .run();
      });
    },

    async listByTeam(teamId: string): Promise<Integration[]> {
      const rows = db.getDB()
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.team_id, teamId))
        .all();
      return rows as Integration[];
    },

    async updateStatus(id: string, status: IntegrationStatus, errorMessage?: string): Promise<void> {
      const existing = db.getDB()
        .select({ status: schema.integrations.status })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Integration not found: ${id}`);
      }

      const allowed = VALID_INTEGRATION_TRANSITIONS[existing.status];
      if (!allowed || !allowed.has(status)) {
        throw new InvalidTransitionError(
          `Invalid integration status transition: ${existing.status} -> ${status}`
        );
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.integrations)
          .set({
            status,
            ...(errorMessage !== undefined ? { error_message: errorMessage } : {}),
          })
          .where(eq(schema.integrations.id, id))
          .run();
      });
    },
  };
}
