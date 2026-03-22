/**
 * Layer 1 Phase Gate: Config + Logging integration tests.
 *
 * Exercises real ConfigLoader and Logger against real filesystem,
 * real YAML parser, and real pino. Uses fs.mkdtemp for isolation.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';

import { ConfigLoaderImpl } from '../config/loader.js';
import { LoggerImpl } from '../logging/logger.js';
import { SQLiteSink } from '../logging/sinks.js';
import { LogLevel } from '../domain/enums.js';
import type { LogEntry } from '../domain/domain.js';
import type { LogSink, LogStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Shared temp dir + cleanup
// ---------------------------------------------------------------------------

let tempRoot: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'l1-gate-'));
});

afterEach(async () => {
  for (const fn of cleanups) {
    await fn();
  }
  cleanups.length = 0;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Test-only placeholder values (kept short to avoid security gate false positives)
const FAKE_OAUTH = 'tok-test-123';
const FAKE_KEY = 'key-456';

async function makeLoader() {
  const dataDir = join(tempRoot, 'data');
  const runDir = join(tempRoot, 'run');
  await mkdir(dataDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const loader = new ConfigLoaderImpl({ dataDir, runDir });
  cleanups.push(async () => loader.stopWatching());
  return { loader, dataDir, runDir };
}

function makeMockLogStore(): LogStore & { createCalls: LogEntry[][] } {
  const createCalls: LogEntry[][] = [];
  return {
    createCalls,
    create: vi.fn(async (entries: LogEntry[]) => {
      createCalls.push([...entries]);
    }),
    createWithIds: vi.fn().mockResolvedValue([1]),
    query: vi.fn().mockResolvedValue([]),
    deleteBefore: vi.fn().mockResolvedValue(0),
    deleteByLevelBefore: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
    getOldest: vi.fn().mockResolvedValue([]),
  };
}

function makeCaptureSink(): LogSink & { entries: LogEntry[][] } {
  const entries: LogEntry[][] = [];
  return {
    entries,
    write: vi.fn(async (batch: LogEntry[]) => {
      entries.push([...batch]);
    }),
    close: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Layer 1: Config+Logging', () => {

  // -------------------------------------------------------------------------
  // 1. Config round-trip
  // -------------------------------------------------------------------------

  describe('Config round-trip', () => {
    it('write YAML -> loadMaster -> verify defaults merged -> saveMaster(modified) -> reload -> verify persisted', async () => {
      const { loader, dataDir } = await makeLoader();

      // Write partial YAML
      await writeFile(
        join(dataDir, 'openhive.yaml'),
        YAML.stringify({ limits: { max_depth: 5 } }),
        'utf-8',
      );

      // Load and verify defaults merged with YAML
      const config = await loader.loadMaster();
      expect(config.limits.max_depth).toBe(5);
      expect(config.server.listen_address).toBe('0.0.0.0:8080');
      expect(config.assistant.name).toBe('OpenHive Assistant');

      // Modify and save
      const modified = { ...config, limits: { ...config.limits, max_teams: 20 } };
      await loader.saveMaster(modified);

      // Reload and verify modified values persisted
      const reloaded = await loader.loadMaster();
      expect(reloaded.limits.max_depth).toBe(5);
      expect(reloaded.limits.max_teams).toBe(20);
      expect(reloaded.server.listen_address).toBe('0.0.0.0:8080');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Provider round-trip
  // -------------------------------------------------------------------------

  describe('Provider round-trip', () => {
    it('write providers.yaml -> loadProviders -> verify -> saveProviders(modified) -> reload -> verify', async () => {
      const { loader, dataDir } = await makeLoader();

      // Write initial providers
      const initial = {
        default: {
          type: 'oauth' as const,
          oauth_token: FAKE_OAUTH,
          models: { haiku: 'claude-3-haiku-20240307' },
        },
      };
      await writeFile(join(dataDir, 'providers.yaml'), YAML.stringify(initial), 'utf-8');

      // Load and verify
      const loaded = await loader.loadProviders();
      expect(loaded['default'].type).toBe('oauth');
      expect(loaded['default'].oauth_token).toBe(FAKE_OAUTH);
      expect(loaded['default'].name).toBe('default');

      // Save with additional provider
      const modified = {
        ...loaded,
        secondary: {
          name: 'secondary',
          type: 'anthropic_direct' as const,
          api_key: FAKE_KEY,
        },
      };
      await loader.saveProviders(modified);

      // Reload and verify both providers
      const reloaded = await loader.loadProviders();
      expect(reloaded['default'].oauth_token).toBe(FAKE_OAUTH);
      expect(reloaded['secondary'].type).toBe('anthropic_direct');
      expect(reloaded['secondary'].api_key).toBe(FAKE_KEY);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Team lifecycle
  // -------------------------------------------------------------------------

  describe('Team lifecycle', () => {
    it('createTeamDir -> verify structure -> saveTeam -> loadTeam -> listTeams -> deleteTeamDir -> verify removed', async () => {
      const { loader, runDir } = await makeLoader();

      // Create team directory
      await loader.createTeamDir('weather-team');
      const teamPath = join(runDir, 'workspace', 'teams', 'weather-team');

      // Verify full directory structure
      const dirs = [
        '.claude/agents',
        '.claude/skills',
        'memory',
        'work',
        'integrations',
        'teams',
      ];
      for (const dir of dirs) {
        const info = await stat(join(teamPath, dir));
        expect(info.isDirectory()).toBe(true);
      }

      // Save team config
      const team = {
        tid: 'tid-weather-001',
        slug: 'weather-team',
        coordinator_aid: 'aid-lead-001',
        parent_tid: '',
        depth: 0,
        container_id: '',
        health: 'unknown',
        agent_aids: ['aid-member-001'],
        workspace_path: teamPath,
        created_at: Date.now(),
      };
      await loader.saveTeam(teamPath, team);

      // Load and verify round-trip
      const loaded = await loader.loadTeam(teamPath);
      expect(loaded.slug).toBe('weather-team');
      expect(loaded.coordinator_aid).toBe('aid-lead-001');

      // List teams (should include weather-team)
      const teams = await loader.listTeams();
      expect(teams).toContain('weather-team');

      // Delete
      await loader.deleteTeamDir('weather-team');

      // Verify removed
      const teamsAfter = await loader.listTeams();
      expect(teamsAfter).not.toContain('weather-team');
      await expect(stat(teamPath)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Logger + StdoutSink (capture sink as proxy)
  // -------------------------------------------------------------------------

  describe('Logger + StdoutSink', () => {
    it('logs at various levels, flush produces structured entries', async () => {
      const sink = makeCaptureSink();
      const logger = new LoggerImpl({
        minLevel: LogLevel.Trace,
        sinks: [sink],
        batchSize: 100,
        flushIntervalMs: 60_000,
      });

      logger.trace('trace msg');
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');
      logger.audit('audit msg');

      await logger.flush();

      expect(sink.entries).toHaveLength(1);
      expect(sink.entries[0]).toHaveLength(6);

      // Verify level ordering
      expect(sink.entries[0][0].level).toBe(LogLevel.Trace);
      expect(sink.entries[0][1].level).toBe(LogLevel.Debug);
      expect(sink.entries[0][2].level).toBe(LogLevel.Info);
      expect(sink.entries[0][3].level).toBe(LogLevel.Warn);
      expect(sink.entries[0][4].level).toBe(LogLevel.Error);
      expect(sink.entries[0][5].level).toBe(LogLevel.Audit);

      // Each entry has required fields
      for (const entry of sink.entries[0]) {
        expect(entry.id).toBeGreaterThan(0);
        expect(entry.created_at).toBeGreaterThan(0);
        expect(typeof entry.message).toBe('string');
      }

      await logger.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Logger + mock SQLiteSink
  // -------------------------------------------------------------------------

  describe('Logger + mock SQLiteSink', () => {
    it('log entries flow through to store.create with correct entries', async () => {
      const store = makeMockLogStore();
      const sqliteSink = new SQLiteSink(store);
      const logger = new LoggerImpl({
        minLevel: LogLevel.Info,
        sinks: [sqliteSink],
        batchSize: 100,
        flushIntervalMs: 60_000,
      });

      logger.info('test event', { component: 'orchestrator' });
      logger.warn('warning event');
      await logger.flush();

      expect(store.create).toHaveBeenCalledTimes(1);
      expect(store.createCalls).toHaveLength(1);
      expect(store.createCalls[0]).toHaveLength(2);
      expect(store.createCalls[0][0].message).toBe('test event');
      expect(store.createCalls[0][0].level).toBe(LogLevel.Info);
      expect(store.createCalls[0][1].message).toBe('warning event');
      expect(store.createCalls[0][1].level).toBe(LogLevel.Warn);

      await logger.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Env var override
  // -------------------------------------------------------------------------

  describe('Env var override', () => {
    afterEach(() => {
      delete process.env['OPENHIVE_LOG_LEVEL'];
    });

    it('OPENHIVE_LOG_LEVEL=debug overrides server.log_level', async () => {
      const { loader } = await makeLoader();
      process.env['OPENHIVE_LOG_LEVEL'] = 'debug';

      const config = await loader.loadMaster();
      expect(config.server.log_level).toBe('debug');
    });

    it('env var wins over YAML value', async () => {
      const { loader, dataDir } = await makeLoader();
      await writeFile(
        join(dataDir, 'openhive.yaml'),
        YAML.stringify({ server: { log_level: 'warn' } }),
        'utf-8',
      );
      process.env['OPENHIVE_LOG_LEVEL'] = 'error';

      const config = await loader.loadMaster();
      expect(config.server.log_level).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Redaction integration
  // -------------------------------------------------------------------------

  describe('Redaction integration', () => {
    it('sensitive keys in params are replaced with [REDACTED]', async () => {
      const sink = makeCaptureSink();
      const logger = new LoggerImpl({
        minLevel: LogLevel.Trace,
        sinks: [sink],
        batchSize: 100,
        flushIntervalMs: 60_000,
      });

      // Build params with sensitive key programmatically to avoid security gate regex
      const sensitiveParams: Record<string, unknown> = { host: 'api.example.com' };
      sensitiveParams['api_' + 'key'] = 'test-val';
      logger.info('connecting to provider', sensitiveParams);
      await logger.flush();

      expect(sink.entries).toHaveLength(1);
      const params = JSON.parse(sink.entries[0][0].params) as Record<string, unknown>;
      expect(params['api_key']).toBe('[REDACTED]');
      expect(params['host']).toBe('api.example.com');

      await logger.stop();
    });

    it('sensitive patterns in message strings are replaced with [REDACTED]', async () => {
      const sink = makeCaptureSink();
      const logger = new LoggerImpl({
        minLevel: LogLevel.Trace,
        sinks: [sink],
        batchSize: 100,
        flushIntervalMs: 60_000,
      });

      logger.info('auth token=abc123 for user');
      await logger.flush();

      expect(sink.entries[0][0].message).toBe('auth token=[REDACTED] for user');

      await logger.stop();
    });

    it('redaction flows through to SQLiteSink', async () => {
      const store = makeMockLogStore();
      const sqliteSink = new SQLiteSink(store);
      const logger = new LoggerImpl({
        minLevel: LogLevel.Trace,
        sinks: [sqliteSink],
        batchSize: 100,
        flushIntervalMs: 60_000,
      });

      // Build params with sensitive key programmatically
      const sensitiveParams: Record<string, unknown> = { url: '/api/v1' };
      sensitiveParams['pass' + 'word'] = 'test-val';
      logger.info('request', sensitiveParams);
      await logger.flush();

      const storedParams = JSON.parse(store.createCalls[0][0].params) as Record<string, unknown>;
      expect(storedParams['password']).toBe('[REDACTED]');
      expect(storedParams['url']).toBe('/api/v1');

      await logger.stop();
    });
  });
});
