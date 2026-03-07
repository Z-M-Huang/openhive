/**
 * Tests for Archiver — periodic log archiving to .json.gz files with rotation.
 *
 * Covers:
 *   - ArchiveOnce exports oldest entries to a gzip file
 *   - ArchiveOnce deletes archived entries from DB after writing the file
 *   - Rotate removes oldest archives beyond keepCopies
 *   - No archiving when count <= maxEntries
 *   - No archiving when disabled
 *   - Archive files are named with UTC timestamp (logs-YYYYMMDD-HHMMSS.json.gz)
 *
 * Uses a real temporary directory so gzip file I/O is exercised end-to-end.
 * The LogStore is mocked to control count, getOldest, and deleteBefore
 * without needing a real database.
 *
 * The LogStore is mocked to control count, getOldest, and deleteBefore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockedObject } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as os from 'node:os';
import type { LogStore } from '../domain/interfaces.js';
import type { LogEntry } from '../domain/types.js';
import type { ArchiveConfig } from '../domain/types.js';
import { Archiver, newArchiver } from './archive.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal LogEntry for tests. */
function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: overrides.id ?? 1,
    level: overrides.level ?? 'info',
    component: overrides.component ?? 'test',
    action: overrides.action ?? 'test.action',
    message: overrides.message ?? 'test message',
    created_at: overrides.created_at ?? new Date(1_000_000),
    ...overrides,
  };
}

/** Create a mock LogStore with sensible defaults. */
function makeMockStore(overrides: Partial<MockedObject<LogStore>> = {}): MockedObject<LogStore> {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    deleteBefore: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
    getOldest: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Create a minimal enabled ArchiveConfig pointing to a temp directory. */
function makeConfig(archiveDir: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return {
    enabled: true,
    max_entries: 100,
    keep_copies: 3,
    archive_dir: archiveDir,
    ...overrides,
  };
}

/**
 * Read a .json.gz file and parse each newline-delimited JSON object.
 * Returns an array of parsed LogEntry objects.
 */
function readGzipArchive(filePath: string): LogEntry[] {
  const compressed = fs.readFileSync(filePath);
  const raw = zlib.gunzipSync(compressed).toString('utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as LogEntry);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-archive-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Disabled archiving
// ---------------------------------------------------------------------------

describe('Archiver — disabled', () => {
  it('does nothing when config.enabled is false', async () => {
    const store = makeMockStore({ count: vi.fn().mockResolvedValue(9999) });
    const cfg = makeConfig(tmpDir, { enabled: false });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    expect(store.count).not.toHaveBeenCalled();
    expect(store.getOldest).not.toHaveBeenCalled();
    expect(store.deleteBefore).not.toHaveBeenCalled();

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No archiving when count <= maxEntries
// ---------------------------------------------------------------------------

describe('Archiver — count threshold', () => {
  it('skips archiving when count equals maxEntries', async () => {
    const store = makeMockStore({ count: vi.fn().mockResolvedValue(100) });
    const cfg = makeConfig(tmpDir, { max_entries: 100 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    expect(store.getOldest).not.toHaveBeenCalled();
    expect(store.deleteBefore).not.toHaveBeenCalled();

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });

  it('skips archiving when count is below maxEntries', async () => {
    const store = makeMockStore({ count: vi.fn().mockResolvedValue(50) });
    const cfg = makeConfig(tmpDir, { max_entries: 100 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    expect(store.getOldest).not.toHaveBeenCalled();
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });

  it('archives when count exceeds maxEntries by one', async () => {
    const entries = [makeEntry({ created_at: new Date(1_000) })];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(101),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir, { max_entries: 100 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    expect(store.getOldest).toHaveBeenCalledWith(1000);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Archive file content
// ---------------------------------------------------------------------------

describe('Archiver — archive file content', () => {
  it('exports oldest entries to a gzip JSON file', async () => {
    const entries = [
      makeEntry({ id: 1, message: 'first', created_at: new Date(1_000) }),
      makeEntry({ id: 2, message: 'second', created_at: new Date(2_000) }),
      makeEntry({ id: 3, message: 'third', created_at: new Date(3_000) }),
    ];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(3),
    });
    const cfg = makeConfig(tmpDir, { max_entries: 100 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^logs-\d{8}-\d{6}\.json\.gz$/);

    const parsed = readGzipArchive(path.join(tmpDir, files[0]!));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.message).toBe('first');
    expect(parsed[1]?.message).toBe('second');
    expect(parsed[2]?.message).toBe('third');
  });

  it('archive file is valid gzip (can be decompressed)', async () => {
    const entries = [makeEntry({ message: 'hello gzip' })];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(500),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir);
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);

    // Verify the file is valid gzip by decompressing without error
    const compressed = fs.readFileSync(path.join(tmpDir, files[0]!));
    expect(() => zlib.gunzipSync(compressed)).not.toThrow();
  });

  it('archive file is named with UTC timestamp format logs-YYYYMMDD-HHMMSS.json.gz', async () => {
    const entries = [makeEntry()];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir);
    const archiver = new Archiver(store, cfg);

    const before = new Date();
    await archiver.archiveOnce();
    const after = new Date();

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);

    const name = files[0]!;
    // Format: logs-YYYYMMDD-HHMMSS.json.gz
    expect(name).toMatch(/^logs-\d{8}-\d{6}\.json\.gz$/);

    // Extract the timestamp from the filename and verify it's between before and after
    const match = name.match(/^logs-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json\.gz$/);
    expect(match).not.toBeNull();
    if (match) {
      const ts = new Date(
        Date.UTC(
          parseInt(match[1]!, 10),
          parseInt(match[2]!, 10) - 1,
          parseInt(match[3]!, 10),
          parseInt(match[4]!, 10),
          parseInt(match[5]!, 10),
          parseInt(match[6]!, 10),
        ),
      );
      // Timestamp should be within a 60-second window (accounting for second-level granularity)
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    }
  });
});

// ---------------------------------------------------------------------------
// Deletion of archived entries
// ---------------------------------------------------------------------------

describe('Archiver — deletion of archived entries', () => {
  it('calls deleteBefore with oldest-entry created_at plus 1ms', async () => {
    const oldest = new Date(5_000);
    const entries = [
      makeEntry({ created_at: new Date(1_000) }),
      makeEntry({ created_at: new Date(3_000) }),
      makeEntry({ created_at: oldest }),
    ];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(3),
    });
    const cfg = makeConfig(tmpDir);
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    // deleteBefore should be called with the oldest entry's created_at + 1ms
    // The oldest entry is the LAST in the entries array (entries are sorted ASC,
    // so the last one has the newest timestamp among the fetched batch).
    const deleteBeforeMock = store.deleteBefore as ReturnType<typeof vi.fn>;
    expect(deleteBeforeMock).toHaveBeenCalledTimes(1);

    const cutoff: Date = deleteBeforeMock.mock.calls[0][0] as Date;
    expect(cutoff.getTime()).toBe(oldest.getTime() + 1);
  });

  it('does not call deleteBefore when getOldest returns empty array', async () => {
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue([]),
      deleteBefore: vi.fn().mockResolvedValue(0),
    });
    const cfg = makeConfig(tmpDir);
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    expect(store.deleteBefore).not.toHaveBeenCalled();
  });

  it('creates archive directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'archive', 'dir');
    const entries = [makeEntry()];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(nestedDir);
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    expect(fs.existsSync(nestedDir)).toBe(true);
    const files = fs.readdirSync(nestedDir);
    expect(files).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rotation of old archives
// ---------------------------------------------------------------------------

describe('Archiver — rotation', () => {
  /** Write a fake archive file with the given name to tmpDir. */
  function writeArchiveFile(name: string): void {
    const content = zlib.gzipSync(Buffer.from('{"id":1,"message":"test"}\n'));
    fs.writeFileSync(path.join(tmpDir, name), content);
  }

  it('removes oldest archives when count exceeds keepCopies after archiving', async () => {
    // Pre-populate 3 archive files (the max)
    writeArchiveFile('logs-20240101-000000.json.gz');
    writeArchiveFile('logs-20240102-000000.json.gz');
    writeArchiveFile('logs-20240103-000000.json.gz');

    const entries = [makeEntry()];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir, { keep_copies: 3 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    // After archiving, we have 4 archives (3 pre-existing + 1 new).
    // keep_copies=3 → oldest 1 should be removed.
    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toHaveLength(3);
    // The oldest file (20240101) should have been removed
    expect(files).not.toContain('logs-20240101-000000.json.gz');
    // The newer ones should remain
    expect(files).toContain('logs-20240102-000000.json.gz');
    expect(files).toContain('logs-20240103-000000.json.gz');
  });

  it('removes multiple old archives when count far exceeds keepCopies', async () => {
    // Pre-populate 5 archive files, keepCopies=2
    writeArchiveFile('logs-20240101-000000.json.gz');
    writeArchiveFile('logs-20240102-000000.json.gz');
    writeArchiveFile('logs-20240103-000000.json.gz');
    writeArchiveFile('logs-20240104-000000.json.gz');
    writeArchiveFile('logs-20240105-000000.json.gz');

    const entries = [makeEntry()];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir, { keep_copies: 2 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    // 5 pre-existing + 1 new = 6 total → keep only 2
    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toHaveLength(2);
    // Only the 2 newest should remain (the new one + 20240105)
    expect(files).toContain('logs-20240105-000000.json.gz');
  });

  it('does not remove any archives when count is within keepCopies', async () => {
    // Pre-populate 2 archive files, keepCopies=3
    writeArchiveFile('logs-20240101-000000.json.gz');
    writeArchiveFile('logs-20240102-000000.json.gz');

    const entries = [makeEntry()];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir, { keep_copies: 3 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    // 2 pre-existing + 1 new = 3 total → within keepCopies, no removal
    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toHaveLength(3);
    expect(files).toContain('logs-20240101-000000.json.gz');
    expect(files).toContain('logs-20240102-000000.json.gz');
  });

  it('skips rotation when keepCopies is 0', async () => {
    writeArchiveFile('logs-20240101-000000.json.gz');
    writeArchiveFile('logs-20240102-000000.json.gz');

    const entries = [makeEntry()];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir, { keep_copies: 0 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    // keepCopies=0 means skip rotation entirely (matching Go behaviour)
    const files = fs.readdirSync(tmpDir).sort();
    // 2 pre-existing + 1 new = 3 total, no rotation
    expect(files).toHaveLength(3);
  });

  it('only considers logs-*.json.gz files for rotation, ignores other files', async () => {
    writeArchiveFile('logs-20240101-000000.json.gz');
    writeArchiveFile('logs-20240102-000000.json.gz');
    writeArchiveFile('logs-20240103-000000.json.gz');
    // Write a non-archive file that should not be counted or removed
    fs.writeFileSync(path.join(tmpDir, 'other-file.txt'), 'not an archive');

    const entries = [makeEntry()];
    const store = makeMockStore({
      count: vi.fn().mockResolvedValue(200),
      getOldest: vi.fn().mockResolvedValue(entries),
      deleteBefore: vi.fn().mockResolvedValue(1),
    });
    const cfg = makeConfig(tmpDir, { keep_copies: 3 });
    const archiver = new Archiver(store, cfg);

    await archiver.archiveOnce();

    // other-file.txt must NOT be removed
    expect(fs.existsSync(path.join(tmpDir, 'other-file.txt'))).toBe(true);

    // 3 pre-existing archives + 1 new = 4, keep 3 → remove 1 oldest
    const archiveFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json.gz'));
    expect(archiveFiles).toHaveLength(3);
    expect(archiveFiles).not.toContain('logs-20240101-000000.json.gz');
  });
});

// ---------------------------------------------------------------------------
// start / stop lifecycle
// ---------------------------------------------------------------------------

describe('Archiver — start/stop lifecycle', () => {
  it('stop() resolves immediately when archiver has not been started', async () => {
    const store = makeMockStore();
    const cfg = makeConfig(tmpDir);
    const archiver = new Archiver(store, cfg);

    await expect(archiver.stop()).resolves.toBeUndefined();
  });

  it('stop() resolves after start() without triggering an archive run', async () => {
    vi.useFakeTimers();

    const store = makeMockStore({ count: vi.fn().mockResolvedValue(0) });
    const cfg = makeConfig(tmpDir);
    const archiver = new Archiver(store, cfg);

    archiver.start();
    // Do not advance timers — stop immediately
    await archiver.stop();

    // No archive run should have occurred
    expect(store.count).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    const store = makeMockStore();
    const cfg = makeConfig(tmpDir);
    const archiver = new Archiver(store, cfg);

    archiver.start();
    await archiver.stop();
    await expect(archiver.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// newArchiver factory
// ---------------------------------------------------------------------------

describe('newArchiver factory', () => {
  it('creates an Archiver instance', () => {
    const store = makeMockStore();
    const cfg = makeConfig(tmpDir);
    const archiver = newArchiver(store, cfg);
    expect(archiver).toBeInstanceOf(Archiver);
  });

  it('factory-created archiver respects disabled config', async () => {
    const store = makeMockStore({ count: vi.fn().mockResolvedValue(9999) });
    const cfg = makeConfig(tmpDir, { enabled: false });
    const archiver = newArchiver(store, cfg);

    await archiver.archiveOnce();

    expect(store.count).not.toHaveBeenCalled();
  });
});
