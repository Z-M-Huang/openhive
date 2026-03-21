/**
 * File-backed credential store. Stores credentials as plaintext files in
 * <workspace>/teams/<teamId>/.credentials/<key>.txt.
 *
 * Implements the CredentialStore interface so all consumers
 * (container_init, invoke_integration, tools) work unchanged.
 */

import { resolve } from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import type { Credential } from '../../domain/domain.js';
import type { CredentialStore } from '../../domain/interfaces.js';
import { NotFoundError } from '../../domain/errors.js';

export function createFileCredentialStore(workspaceRoot: string): CredentialStore {
  function credDir(teamId: string): string {
    return resolve(workspaceRoot, 'teams', teamId, '.credentials');
  }

  function sanitizeKey(name: string): string {
    // Reject path traversal and non-alphanumeric characters (except hyphens/underscores)
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized || sanitized !== name) {
      throw new NotFoundError(`Invalid credential key: "${name}". Keys must be alphanumeric with hyphens/underscores only.`);
    }
    return sanitized;
  }

  function credPath(teamId: string, name: string): string {
    return resolve(credDir(teamId), `${sanitizeKey(name)}.txt`);
  }

  return {
    async create(cred: Credential): Promise<void> {
      sanitizeKey(cred.name); // Validate before any filesystem operation
      const dir = credDir(cred.team_id);
      await mkdir(dir, { recursive: true });
      // encrypted_value contains plaintext in file-backed mode
      await writeFile(credPath(cred.team_id, cred.name), cred.encrypted_value, 'utf-8');
    },

    async get(id: string): Promise<Credential> {
      // ID format: "cred-<timestamp>" — not easily mapped to file.
      // This is a legacy interface method; file store uses listByTeam + find.
      throw new NotFoundError(`get() by ID not supported in file credential store: ${id}`);
    },

    async update(cred: Credential): Promise<void> {
      const dir = credDir(cred.team_id);
      await mkdir(dir, { recursive: true });
      await writeFile(credPath(cred.team_id, cred.name), cred.encrypted_value, 'utf-8');
    },

    async delete(id: string): Promise<void> {
      // Same limitation as get() — use deleteByTeamAndName instead
      throw new NotFoundError(`delete() by ID not supported in file credential store: ${id}`);
    },

    async listByTeam(teamId: string): Promise<Credential[]> {
      const dir = credDir(teamId);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return []; // No .credentials dir — no credentials
      }

      const results: Credential[] = [];
      for (const file of files) {
        if (!file.endsWith('.txt')) continue;
        const name = file.replace(/\.txt$/, '');
        try {
          const value = await readFile(resolve(dir, file), 'utf-8');
          results.push({
            id: `file-${teamId}-${name}`,
            name,
            encrypted_value: value, // Plaintext value — no trim to preserve exact content
            team_id: teamId,
            created_at: 0,
          });
        } catch {
          // Skip unreadable files
        }
      }
      return results;
    },
  };
}
