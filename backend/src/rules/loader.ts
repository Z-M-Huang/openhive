/**
 * Rule loader — reads .md rule files from a directory.
 *
 * Returns files sorted by filename for deterministic ordering.
 * Gracefully handles missing or empty directories.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RuleFile {
  readonly filename: string;
  readonly content: string;
}

export function loadRulesFromDirectory(dirPath: string): RuleFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    // Missing directory — not an error, just no rules
    return [];
  }

  const mdFiles = entries
    .filter((f) => f.endsWith('.md'))
    .sort();

  return mdFiles.map((filename) => ({
    filename,
    content: readFileSync(join(dirPath, filename), 'utf-8'),
  }));
}
