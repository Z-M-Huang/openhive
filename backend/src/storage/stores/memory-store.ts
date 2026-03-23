/**
 * Memory store — filesystem-backed implementation of IMemoryStore.
 *
 * Stores per-team memory files with path traversal protection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IMemoryStore } from '../../domain/interfaces.js';
import { ValidationError } from '../../domain/errors.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class MemoryStore implements IMemoryStore {
  constructor(private readonly baseDir: string) {}

  readFile(teamName: string, filename: string): string | undefined {
    this.validateTeamName(teamName);
    this.validateFilename(filename);

    const filePath = join(this.baseDir, teamName, 'memory', filename);
    if (!existsSync(filePath)) return undefined;
    return readFileSync(filePath, 'utf-8');
  }

  writeFile(teamName: string, filename: string, content: string): void {
    this.validateTeamName(teamName);
    this.validateFilename(filename);

    const dir = join(this.baseDir, teamName, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content, 'utf-8');
  }

  listFiles(teamName: string): string[] {
    this.validateTeamName(teamName);

    const dir = join(this.baseDir, teamName, 'memory');
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  }

  private validateTeamName(teamName: string): void {
    if (!SLUG_RE.test(teamName)) {
      throw new ValidationError(`Invalid team name: ${teamName}`);
    }
  }

  private validateFilename(filename: string): void {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new ValidationError(`Invalid filename: ${filename}`);
    }
  }
}
