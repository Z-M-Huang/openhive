/**
 * Repository filesystem helpers for UAT scenarios.
 *
 * Provides utilities for checking file existence and searching source code.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Check if a file exists at the given path.
 */
export function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Check if a directory exists at the given path.
 */
export function dirExists(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Result from grepRepo search.
 */
export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GrepOptions {
  /** Case-insensitive search */
  ignoreCase?: boolean;
  /** Root directory to search from (defaults to process.cwd()) */
  rootDir?: string;
  /** File glob pattern to filter */
  glob?: string;
}

/**
 * Search repository files for a pattern.
 * Returns all matches with file path, line number, and content.
 */
export function grepRepo(pattern: string, opts?: GrepOptions): GrepMatch[] {
  const rootDir = opts?.rootDir ?? process.cwd();
  const regex = new RegExp(pattern, opts?.ignoreCase ? 'gi' : 'g');
  const matches: GrepMatch[] = [];

  function walkDir(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      // Skip node_modules and hidden directories
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue;
        }
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        // Filter by glob if provided
        if (opts?.glob) {
          const relPath = relative(rootDir, fullPath);
          // Simple glob check - just check suffix for patterns like "*.test.ts"
          if (opts.glob.includes('*')) {
            const parts = opts.glob.split('*');
            if (parts.length === 2) {
              const prefix = parts[0];
              const suffix = parts[1];
              if (!relPath.startsWith(prefix) || !relPath.endsWith(suffix)) {
                continue;
              }
            }
          }
        }

        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (regex.test(line)) {
              matches.push({
                file: relative(rootDir, fullPath),
                line: i + 1,
                content: line.trim(),
              });
              // Reset regex lastIndex for each line
              regex.lastIndex = 0;
            }
          }
        } catch {
          // Skip files that can't be read
        }
      }
    }
  }

  walkDir(rootDir);
  return matches;
}

/**
 * Read a file's contents.
 */
export function readFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * List files in a directory (non-recursive).
 */
export function listFiles(dir: string): string[] {
  if (!dirExists(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * List directories in a directory (non-recursive).
 */
export function listDirs(dir: string): string[] {
  if (!dirExists(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch {
    return [];
  }
}