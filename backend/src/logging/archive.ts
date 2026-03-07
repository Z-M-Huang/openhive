/**
 * OpenHive Backend - Log Archiver
 *
 * Exports oldest log entries to .json.gz files and rotates old archives.
 *
 * Design notes:
 *   - archiveOnce() is the core operation: check count, get oldest 1000 entries,
 *     write a gzip JSON file, delete the archived entries from the DB, then rotate.
 *   - Each archive file is named logs-YYYYMMDD-HHMMSS.json.gz using UTC time.
 *   - Gzip is produced via node:zlib using BEST_SPEED (level 1).
 *   - Each LogEntry is serialized as a single-line JSON object followed by '\n',
 *     producing a newline-delimited JSON (NDJSON) stream within the gzip file.
 *   - Rotation keeps at most keepCopies archives. If keepCopies <= 0, rotation
 *     is skipped entirely.
 *   - Only files matching logs-*.json.gz are considered for rotation.
 *   - start() sets a 5-minute interval. stop() clears it and waits for any
 *     in-progress archiveOnce() call to complete before resolving.
 *   - archiveOnce() is exported as a public method for testing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type { LogStore } from '../domain/interfaces.js';
import type { LogEntry } from '../domain/types.js';
import type { ArchiveConfig } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of entries to fetch and archive in a single pass. */
const ARCHIVE_BATCH_SIZE = 1000;

/** Interval between archive checks (5 minutes in ms). */
const ARCHIVE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Directory permissions for archive directory creation. */
const DIR_PERMISSIONS = 0o700;

/** File permissions for archive files. */
const FILE_PERMISSIONS = 0o600;

// ---------------------------------------------------------------------------
// Archiver
// ---------------------------------------------------------------------------

/**
 * Archiver manages log archive operations.
 *
 * Typical usage:
 *   const archiver = newArchiver(logStore, cfg);
 *   archiver.start();   // begins 5-minute periodic checks
 *   await archiver.stop(); // graceful shutdown — waits for in-progress run
 */
export class Archiver {
  private readonly store: LogStore;
  private readonly cfg: ArchiveConfig;
  private readonly logger: PinoLogger;
  private timer: ReturnType<typeof setInterval> | null;
  private inProgressPromise: Promise<void> | null;
  private stopped: boolean;

  constructor(store: LogStore, cfg: ArchiveConfig) {
    this.store = store;
    this.cfg = cfg;
    this.logger = pino({ level: 'info' });
    this.timer = null;
    this.inProgressPromise = null;
    this.stopped = false;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /**
   * Begins the periodic archive check at 5-minute intervals.
   */
  start(): void {
    this.timer = setInterval(() => {
      // Track in-progress promise so stop() can wait for it.
      this.inProgressPromise = this.archiveOnce().then(() => {
        this.inProgressPromise = null;
      });
    }, ARCHIVE_CHECK_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /**
   * Clears the interval timer and waits for any in-progress archiveOnce()
   * call to complete. Idempotent — calling stop() multiple times is safe.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inProgressPromise !== null) {
      await this.inProgressPromise;
    }
  }

  // -------------------------------------------------------------------------
  // archiveOnce
  // -------------------------------------------------------------------------

  /**
   * Performs a single archive check and export.
   *
   * Steps:
   *   1. If disabled, return immediately.
   *   2. Count total entries; if <= maxEntries, return.
   *   3. Fetch oldest ARCHIVE_BATCH_SIZE entries.
   *   4. Ensure archive directory exists.
   *   5. Write gzip JSON archive file.
   *   6. Delete archived entries from DB (using last entry's created_at + 1ms).
   *   7. Rotate old archives.
   *
   * Exported for testing.
   */
  async archiveOnce(): Promise<void> {
    if (!this.cfg.enabled) {
      return;
    }

    let count: number;
    try {
      count = await this.store.count();
    } catch (err) {
      this.logger.error({ error: String(err) }, 'archive: failed to count logs');
      return;
    }

    if (count <= this.cfg.max_entries) {
      return;
    }

    let entries: LogEntry[];
    try {
      entries = await this.store.getOldest(ARCHIVE_BATCH_SIZE);
    } catch (err) {
      this.logger.error({ error: String(err) }, 'archive: failed to get oldest entries');
      return;
    }

    if (entries.length === 0) {
      return;
    }

    // Ensure archive directory exists
    const archiveDir = this.cfg.archive_dir !== '' ? this.cfg.archive_dir : 'data/archives';
    try {
      fs.mkdirSync(archiveDir, { recursive: true, mode: DIR_PERMISSIONS });
    } catch (err) {
      this.logger.error(
        { error: String(err), dir: archiveDir },
        'archive: failed to create archive directory',
      );
      return;
    }

    // Build filename using UTC timestamp (YYYYMMDD-HHMMSS format)
    const now = new Date();
    const filename = `logs-${formatUTCTimestamp(now)}.json.gz`;
    const filePath = path.join(archiveDir, filename);

    try {
      await this.writeArchiveFile(filePath, entries);
    } catch (err) {
      this.logger.error(
        { error: String(err), path: filePath },
        'archive: failed to write archive file',
      );
      return;
    }

    // Delete archived entries: cutoff = last entry's created_at + 1ms
    // entries[entries.length - 1] is the last (most recent) of the oldest batch.
    const lastEntry = entries[entries.length - 1]!;
    const cutoff = new Date(lastEntry.created_at.getTime() + 1);

    let deleted: number;
    try {
      deleted = await this.store.deleteBefore(cutoff);
    } catch (err) {
      this.logger.error({ error: String(err) }, 'archive: failed to delete archived entries');
      return;
    }

    this.logger.info(
      { archived: entries.length, deleted, file: filePath },
      'archive: exported and deleted logs',
    );

    // Rotate old archives
    this.rotate(archiveDir);
  }

  // -------------------------------------------------------------------------
  // Private — writeArchiveFile
  // -------------------------------------------------------------------------

  /**
   * Writes entries as newline-delimited JSON to a gzip-compressed file.
   *
   * Each entry is serialized as a single JSON object followed by '\n',
   * matching NDJSON convention (each encoder call appends a newline).
   *
   * Uses BEST_SPEED (level 1) for fast compression.
   */
  private async writeArchiveFile(filePath: string, entries: LogEntry[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // O_EXCL ensures we fail if the file already exists.
      let fd: number;
      try {
        fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL, FILE_PERMISSIONS);
      } catch (err) {
        reject(new Error(`failed to create archive file: ${String(err)}`));
        return;
      }

      const fileStream = fs.createWriteStream('', { fd, autoClose: true });
      const gzipStream = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });

      // Build NDJSON payload in memory (entries are a bounded batch of ≤1000)
      const lines: string[] = entries.map((entry) => JSON.stringify(entry) + '\n');
      const payload = lines.join('');

      gzipStream.pipe(fileStream);

      fileStream.on('error', (err) => {
        reject(new Error(`failed to write archive file: ${String(err)}`));
      });

      gzipStream.on('error', (err) => {
        reject(new Error(`gzip error writing archive file: ${String(err)}`));
      });

      fileStream.on('finish', () => {
        resolve();
      });

      gzipStream.end(payload);
    });
  }

  // -------------------------------------------------------------------------
  // Private — rotate
  // -------------------------------------------------------------------------

  /**
   * Lists archive files in archiveDir sorted alphabetically, then removes
   * the oldest entries until only keepCopies remain.
   *
   * Only files matching the pattern logs-*.json.gz are considered.
   * If keepCopies <= 0, rotation is skipped.
   */
  private rotate(archiveDir: string): void {
    if (this.cfg.keep_copies <= 0) {
      return;
    }

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(archiveDir, { withFileTypes: true });
    } catch (err) {
      this.logger.error({ error: String(err) }, 'archive: failed to read archive directory');
      return;
    }

    // Collect archive filenames matching logs-*.json.gz
    const archives: string[] = dirEntries
      .filter(
        (e) =>
          !e.isDirectory() &&
          e.name.startsWith('logs-') &&
          e.name.endsWith('.json.gz'),
      )
      .map((e) => e.name)
      .sort(); // alphabetical sort = chronological sort (timestamp in name)

    // Remove oldest archives until we're within keepCopies
    while (archives.length > this.cfg.keep_copies) {
      const oldest = archives.shift()!;
      const filePath = path.join(archiveDir, oldest);
      try {
        fs.rmSync(filePath);
        this.logger.info({ path: filePath }, 'archive: rotated old archive');
      } catch (err) {
        this.logger.error(
          { error: String(err), path: filePath },
          'archive: failed to remove old archive',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Formats a Date as "YYYYMMDD-HHMMSS" in UTC. */
function formatUTCTimestamp(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const min = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new Archiver with the given LogStore and ArchiveConfig.
 * The interval timer does NOT start automatically — call start() explicitly.
 */
export function newArchiver(store: LogStore, cfg: ArchiveConfig): Archiver {
  return new Archiver(store, cfg);
}
