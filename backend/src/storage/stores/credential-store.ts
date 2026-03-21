/**
 * CredentialStore implementation (DB-backed, kept for reference).
 *
 * @module storage/stores/credential-store
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { CredentialStore } from '../../domain/interfaces.js';
import type { Credential } from '../../domain/domain.js';
import { NotFoundError } from '../../domain/errors.js';

export function newCredentialStore(db: Database): CredentialStore {
  return {
    async create(credential: Credential): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.credentials).values({
          id: credential.id,
          name: credential.name,
          encrypted_value: credential.encrypted_value,
          team_id: credential.team_id,
          created_at: credential.created_at,
        }).run();
      });
    },

    async get(id: string): Promise<Credential> {
      const row = db.getDB()
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.id, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Credential not found: ${id}`);
      }
      return row as Credential;
    },

    async update(credential: Credential): Promise<void> {
      const existing = db.getDB()
        .select({ id: schema.credentials.id })
        .from(schema.credentials)
        .where(eq(schema.credentials.id, credential.id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Credential not found: ${credential.id}`);
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.credentials)
          .set({
            name: credential.name,
            encrypted_value: credential.encrypted_value,
            team_id: credential.team_id,
          })
          .where(eq(schema.credentials.id, credential.id))
          .run();
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.credentials)
          .where(eq(schema.credentials.id, id))
          .run();
      });
    },

    async listByTeam(teamId: string): Promise<Credential[]> {
      const rows = db.getDB()
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.team_id, teamId))
        .all();
      return rows as Credential[];
    },
  };
}
