import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type {
  LogStore,
  MemoryStore,
  Logger,
} from '../domain/interfaces.js';
import { LogLevel } from '../domain/enums.js';

const gzip = promisify(zlib.gzip);

/**
 * Log retention tiers: level -> max age in days.
 * audit = permanent (no expiry).
 */
const RETENTION_DAYS: Record<number, number | null> = {
  [LogLevel.Audit]: null,     // permanent
  [LogLevel.Error]: 90,
  [LogLevel.Warn]: 30,
  [LogLevel.Info]: 30,
  [LogLevel.Debug]: 7,
  [LogLevel.Trace]: 3,
};

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
const ARCHIVE_INTERVAL_MS = 5 * 60 * 1000;     // 5 minutes
const ARCHIVE_THRESHOLD = 100_000;
const ARCHIVE_BATCH_SIZE = 1_000;
const MAX_ARCHIVE_COPIES = 5;

/**
 * Log retention and auto-archive worker.
 *
 * - Retention (1h interval): sweeps expired entries per tier.
 * - Auto-archive (5 min interval): when count > 100K, exports oldest 1K to buffer,
 *   deletes archived, rotates keeping 5 copies.
 * - Shared lock between retention and archive to prevent simultaneous execution (RISK-22).
 * - Memory reconciliation during container reconnection (AC-L8-19).
 */
export class RetentionWorker {
  private readonly logStore: LogStore;
  private readonly memoryStore: MemoryStore;
  private readonly logger: Logger;

  /** Callback to write archive data (gzip NDJSON, base64-encoded). Receives serialized entries. */
  private readonly archiveWriter: (entries: string, copyIndex: number) => Promise<void>;

  private retentionTimer: ReturnType<typeof setInterval> | undefined;
  private archiveTimer: ReturnType<typeof setInterval> | undefined;
  private archiveCopyIndex = 0;

  /** Shared lock: only one of retention/archive runs at a time. */
  private locked = false;

  constructor(deps: {
    logStore: LogStore;
    memoryStore: MemoryStore;
    logger: Logger;
    archiveWriter: (entries: string, copyIndex: number) => Promise<void>;
  }) {
    this.logStore = deps.logStore;
    this.memoryStore = deps.memoryStore;
    this.logger = deps.logger;
    this.archiveWriter = deps.archiveWriter;
  }

  /** Start the retention and archive workers. */
  start(): void {
    this.retentionTimer = setInterval(() => {
      void this.runRetention();
    }, RETENTION_INTERVAL_MS);

    this.archiveTimer = setInterval(() => {
      void this.runArchive();
    }, ARCHIVE_INTERVAL_MS);

    // Don't keep process alive
    if (typeof this.retentionTimer === 'object' && 'unref' in this.retentionTimer) {
      this.retentionTimer.unref();
    }
    if (typeof this.archiveTimer === 'object' && 'unref' in this.archiveTimer) {
      this.archiveTimer.unref();
    }
  }

  /** Stop all workers. */
  stop(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }
    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = undefined;
    }
  }

  /**
   * Run retention sweep: delete expired entries per tier.
   * Skips audit (permanent). Acquires shared lock (RISK-22).
   */
  async runRetention(): Promise<number> {
    if (this.locked) {
      this.logger.debug('Retention skipped: archive in progress');
      return 0;
    }
    this.locked = true;

    let totalDeleted = 0;
    try {
      const now = Date.now();
      for (const [levelStr, maxDays] of Object.entries(RETENTION_DAYS)) {
        if (maxDays === null) continue; // permanent
        const level = Number(levelStr);
        const cutoff = new Date(now - maxDays * 24 * 60 * 60 * 1000);
        const deleted = await this.logStore.deleteByLevelBefore(level, cutoff);
        totalDeleted += deleted;
      }

      if (totalDeleted > 0) {
        this.logger.info('Retention sweep completed', { deleted: totalDeleted });
      }
    } catch (err) {
      this.logger.error('Retention sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.locked = false;
    }

    return totalDeleted;
  }

  /**
   * Run auto-archive: if log count > threshold, export oldest batch,
   * delete archived, rotate keeping max copies.
   */
  async runArchive(): Promise<number> {
    if (this.locked) {
      this.logger.debug('Archive skipped: retention in progress');
      return 0;
    }
    this.locked = true;

    let archived = 0;
    try {
      const count = await this.logStore.count();
      if (count <= ARCHIVE_THRESHOLD) {
        return 0;
      }

      const oldest = await this.logStore.getOldest(ARCHIVE_BATCH_SIZE);
      if (oldest.length === 0) return 0;

      // AC-L8-15: Serialize to NDJSON and gzip compress
      const ndjson = oldest.map((e) => JSON.stringify(e)).join('\n');
      const compressed = await gzip(Buffer.from(ndjson, 'utf8'));

      // Write archive (rotated) - gzip compressed, base64-encoded
      const copyIndex = this.archiveCopyIndex % MAX_ARCHIVE_COPIES;
      await this.archiveWriter(compressed.toString('base64'), copyIndex);
      this.archiveCopyIndex++;

      // Delete archived entries
      const oldestTimestamp = new Date(oldest[oldest.length - 1].created_at);
      await this.logStore.deleteBefore(oldestTimestamp);

      archived = oldest.length;
      this.logger.info('Archive completed', { archived, copy_index: copyIndex });
    } catch (err) {
      this.logger.error('Archive failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.locked = false;
    }

    return archived;
  }

  /**
   * Reconcile memory index from workspace files during container reconnection (AC-L8-19).
   * Re-indexes workspace memory files into SQLite.
   */
  async reconcileMemory(
    agentAid: string,
    teamSlug: string,
    memoryEntries: Array<{ content: string; memoryType: 'curated' | 'daily'; createdAt: number }>,
  ): Promise<number> {
    let indexed = 0;
    for (const entry of memoryEntries) {
      await this.memoryStore.save({
        id: Date.now() + indexed,
        agent_aid: agentAid,
        team_slug: teamSlug,
        content: entry.content,
        memory_type: entry.memoryType,
        created_at: entry.createdAt,
        deleted_at: null,
      });
      indexed++;
    }

    if (indexed > 0) {
      this.logger.info('Memory reconciliation completed', {
        agent_aid: agentAid,
        indexed,
      });
    }

    return indexed;
  }
}
