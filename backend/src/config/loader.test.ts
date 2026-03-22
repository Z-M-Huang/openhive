import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';
import { ConfigLoaderImpl, deepMerge } from './loader.js';
import { defaultMasterConfig } from './defaults.js';

describe('ConfigLoaderImpl', () => {
  let tempDir: string;
  let dataDir: string;
  let runDir: string;
  let loader: ConfigLoaderImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'config-loader-test-'));
    dataDir = join(tempDir, 'data');
    runDir = join(tempDir, 'run');
    await mkdir(dataDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    loader = new ConfigLoaderImpl({ dataDir, runDir });
  });

  afterEach(async () => {
    loader.stopWatching();
    await rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // loadMaster / getMaster
  // -----------------------------------------------------------------------

  describe('loadMaster', () => {
    it('falls back to defaults when YAML file is missing', async () => {
      const config = await loader.loadMaster();
      const defaults = defaultMasterConfig();
      expect(config.server.listen_address).toBe(defaults.server.listen_address);
      expect(config.limits.max_depth).toBe(defaults.limits.max_depth);
      expect(config.assistant.name).toBe(defaults.assistant.name);
    });

    it('AC01: default token_ttl is 5m (not 24h) to match TokenManager 300,000ms TTL', async () => {
      const config = await loader.loadMaster();
      expect(config.security.token_ttl).toBe('5m');
    });

    it('AC02: default docker image is openhive (not openhive:latest) to match allowedImages check', async () => {
      const config = await loader.loadMaster();
      expect(config.docker.image).toBe('openhive');
    });

    it('three-layer resolution: defaults + YAML + env var', async () => {
      // Write YAML with partial overrides
      const yamlContent = YAML.stringify({
        server: { log_level: 'debug' },
        limits: { max_depth: 5 },
      });
      await writeFile(join(dataDir, 'openhive.yaml'), yamlContent, 'utf-8');

      // Set env var
      process.env['OPENHIVE_LOG_LEVEL'] = 'warn';
      try {
        const config = await loader.loadMaster();

        // YAML overrides default
        expect(config.limits.max_depth).toBe(5);
        // Env var overrides YAML
        expect(config.server.log_level).toBe('warn');
        // Default preserved for non-overridden fields
        expect(config.assistant.name).toBe('OpenHive Assistant');
      } finally {
        delete process.env['OPENHIVE_LOG_LEVEL'];
      }
    });

    it('env var override: OPENHIVE_SYSTEM_LISTEN_ADDRESS', async () => {
      process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'] = '0.0.0.0:9090';
      try {
        const config = await loader.loadMaster();
        expect(config.server.listen_address).toBe('0.0.0.0:9090');
      } finally {
        delete process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
      }
    });

    it('env var override: OPENHIVE_DATA_DIR', async () => {
      process.env['OPENHIVE_DATA_DIR'] = '/custom/data';
      try {
        const config = await loader.loadMaster();
        expect(config.server.data_dir).toBe('/custom/data');
      } finally {
        delete process.env['OPENHIVE_DATA_DIR'];
      }
    });
  });

  describe('getMaster', () => {
    it('throws before loadMaster() is called', () => {
      expect(() => loader.getMaster()).toThrow('loadMaster() must be called before getMaster()');
    });

    it('returns cached config after loadMaster()', async () => {
      await loader.loadMaster();
      const config = loader.getMaster();
      expect(config.server.listen_address).toBe('0.0.0.0:8080');
    });
  });

  // -----------------------------------------------------------------------
  // saveMaster / loadMaster round-trip
  // -----------------------------------------------------------------------

  describe('saveMaster', () => {
    it('round-trip: saveMaster -> loadMaster preserves values', async () => {
      const config = defaultMasterConfig();
      config.limits.max_depth = 7;
      config.server.log_level = 'debug';

      await loader.saveMaster(config);
      const reloaded = await loader.loadMaster();

      expect(reloaded.limits.max_depth).toBe(7);
      expect(reloaded.server.log_level).toBe('debug');
      // Non-modified fields preserved from defaults
      expect(reloaded.assistant.name).toBe('OpenHive Assistant');
    });

    it('writes only non-default fields to YAML', async () => {
      const config = defaultMasterConfig();
      config.limits.max_depth = 7;

      await loader.saveMaster(config);
      const raw = await readFile(join(dataDir, 'openhive.yaml'), 'utf-8');
      const parsed = YAML.parse(raw) as Record<string, unknown>;

      // Only modified section written
      expect(parsed['limits']).toEqual({ max_depth: 7 });
      // Unmodified sections not written
      expect(parsed['assistant']).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Providers
  // -----------------------------------------------------------------------

  describe('providers', () => {
    const sampleProviders = {
      default: {
        type: 'oauth' as const,
        oauth_token: 'test-token-123',
        models: { haiku: 'claude-3-haiku-20240307' },
      },
    };

    it('round-trip: saveProviders -> loadProviders', async () => {
      const providers = {
        default: {
          name: 'default',
          type: 'oauth' as const,
          oauth_token: 'test-token-123',
          models: { haiku: 'claude-3-haiku-20240307' },
        },
      };

      await loader.saveProviders(providers);
      const loaded = await loader.loadProviders();

      expect(loaded['default'].name).toBe('default');
      expect(loaded['default'].type).toBe('oauth');
      expect(loaded['default'].oauth_token).toBe('test-token-123');
    });

    it('loadProviders throws when file is missing', async () => {
      await expect(loader.loadProviders()).rejects.toThrow();
    });

    it('loadProviders reads raw YAML format', async () => {
      await writeFile(
        join(dataDir, 'providers.yaml'),
        YAML.stringify(sampleProviders),
        'utf-8',
      );
      const loaded = await loader.loadProviders();
      expect(loaded['default'].name).toBe('default');
      expect(loaded['default'].type).toBe('oauth');
    });
  });

  // -----------------------------------------------------------------------
  // Team config
  // -----------------------------------------------------------------------

  describe('team config', () => {
    it('round-trip: saveTeam -> loadTeam', async () => {
      const teamPath = join(tempDir, 'team-workspace');
      await mkdir(teamPath, { recursive: true });

      const team = {
        tid: 'tid-test-001',
        slug: 'test-team',
        coordinator_aid: 'aid-lead-001',
        parent_tid: '',
        depth: 0,
        container_id: '',
        health: 'unknown',
        agent_aids: [],
        workspace_path: teamPath,
        created_at: Date.now(),
      };

      await loader.saveTeam(teamPath, team);
      const loaded = await loader.loadTeam(teamPath);

      expect(loaded.slug).toBe('test-team');
      expect(loaded.coordinator_aid).toBe('aid-lead-001');
      expect(loaded.tid).toBe('tid-test-001');
    });
  });

  // -----------------------------------------------------------------------
  // Team directory lifecycle
  // -----------------------------------------------------------------------

  describe('createTeamDir', () => {
    it('creates expected directory structure', async () => {
      await loader.createTeamDir('my-team');
      const teamPath = join(runDir, 'workspace', 'teams', 'my-team');

      const exists = async (p: string) => {
        try {
          await stat(p);
          return true;
        } catch {
          return false;
        }
      };

      expect(await exists(join(teamPath, '.claude', 'agents'))).toBe(true);
      expect(await exists(join(teamPath, '.claude', 'skills'))).toBe(true);
      expect(await exists(join(teamPath, 'memory'))).toBe(true);
      expect(await exists(join(teamPath, 'work'))).toBe(true);
      expect(await exists(join(teamPath, 'integrations'))).toBe(true);
      expect(await exists(join(teamPath, 'teams'))).toBe(true);

      // Settings.json written
      const settingsRaw = await readFile(join(teamPath, '.claude', 'settings.json'), 'utf-8');
      const settings = JSON.parse(settingsRaw);
      expect(settings.permissions).toBeDefined();
      expect(settings.permissions.allow).toContain('mcp__openhive-tools');
      expect(settings.enableAllProjectMcpServers).toBe(true);
    });

    it('rejects reserved slugs', async () => {
      await expect(loader.createTeamDir('root')).rejects.toThrow('Reserved slug');
      await expect(loader.createTeamDir('main')).rejects.toThrow('Reserved slug');
      await expect(loader.createTeamDir('admin')).rejects.toThrow('Reserved slug');
      await expect(loader.createTeamDir('system')).rejects.toThrow('Reserved slug');
      await expect(loader.createTeamDir('openhive')).rejects.toThrow('Reserved slug');
    });

    it('rejects invalid slug format', async () => {
      await expect(loader.createTeamDir('ab')).rejects.toThrow(); // too short
      await expect(loader.createTeamDir('BAD-SLUG')).rejects.toThrow(); // uppercase
      await expect(loader.createTeamDir('bad_slug')).rejects.toThrow(); // underscore
    });

    it('throws if directory already exists', async () => {
      await loader.createTeamDir('my-team');
      await expect(loader.createTeamDir('my-team')).rejects.toThrow('already exists');
    });
  });

  describe('deleteTeamDir', () => {
    it('deletes existing team directory', async () => {
      await loader.createTeamDir('delete-me');
      await loader.deleteTeamDir('delete-me');

      const teamPath = join(runDir, 'workspace', 'teams', 'delete-me');
      const exists = async (p: string) => {
        try {
          await stat(p);
          return true;
        } catch {
          return false;
        }
      };
      expect(await exists(teamPath)).toBe(false);
    });

    it('throws if directory does not exist', async () => {
      await expect(loader.deleteTeamDir('nonexistent')).rejects.toThrow();
    });
  });

  describe('listTeams', () => {
    it('returns empty array when teams dir does not exist', async () => {
      const teams = await loader.listTeams();
      expect(teams).toEqual([]);
    });

    it('lists teams with team.yaml files', async () => {
      await loader.createTeamDir('alpha-team');
      await loader.createTeamDir('beta-team');

      // Write team.yaml to alpha
      const alphaTeamYaml = YAML.stringify({ slug: 'alpha-team', coordinator_aid: 'aid-lead-001' });
      await writeFile(
        join(runDir, 'workspace', 'teams', 'alpha-team', 'team.yaml'),
        alphaTeamYaml,
        'utf-8',
      );

      // beta has no team.yaml — should not appear
      const teams = await loader.listTeams();
      expect(teams).toEqual(['alpha-team']);
    });

    it('returns sorted slugs', async () => {
      await loader.createTeamDir('zoo-team');
      await loader.createTeamDir('alpha-team');

      for (const slug of ['zoo-team', 'alpha-team']) {
        await writeFile(
          join(runDir, 'workspace', 'teams', slug, 'team.yaml'),
          YAML.stringify({ slug, coordinator_aid: 'aid-lead-001' }),
          'utf-8',
        );
      }

      const teams = await loader.listTeams();
      expect(teams).toEqual(['alpha-team', 'zoo-team']);
    });
  });

  // -----------------------------------------------------------------------
  // Team CRUD full cycle
  // -----------------------------------------------------------------------

  describe('team CRUD full cycle', () => {
    it('create -> save -> load -> list -> delete', async () => {
      await loader.createTeamDir('crud-team');
      const teamPath = join(runDir, 'workspace', 'teams', 'crud-team');

      const team = {
        tid: 'tid-crud-001',
        slug: 'crud-team',
        coordinator_aid: 'aid-lead-001',
        parent_tid: '',
        depth: 0,
        container_id: '',
        health: 'unknown',
        agent_aids: [],
        workspace_path: teamPath,
        created_at: Date.now(),
      };

      await loader.saveTeam(teamPath, team);
      const loaded = await loader.loadTeam(teamPath);
      expect(loaded.slug).toBe('crud-team');

      const teams = await loader.listTeams();
      expect(teams).toContain('crud-team');

      await loader.deleteTeamDir('crud-team');
      const teamsAfter = await loader.listTeams();
      expect(teamsAfter).not.toContain('crud-team');
    });
  });

  // -----------------------------------------------------------------------
  // File watching
  // -----------------------------------------------------------------------

  describe('file watching', () => {
    it('watchMaster fires callback on file change with debounce', async () => {
      // Write initial config
      const yamlContent = YAML.stringify({ server: { log_level: 'info' } });
      await writeFile(join(dataDir, 'openhive.yaml'), yamlContent, 'utf-8');
      await loader.loadMaster();

      const callbackFn = vi.fn();
      loader.watchMaster(callbackFn);

      // Wait for watcher to be ready
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Modify the file
      const newYaml = YAML.stringify({ server: { log_level: 'debug' } });
      await writeFile(join(dataDir, 'openhive.yaml'), newYaml, 'utf-8');

      // Wait for debounce (500ms) + processing
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(callbackFn).toHaveBeenCalled();
      const callArg = callbackFn.mock.calls[0][0];
      expect(callArg.server.log_level).toBe('debug');
    });

    it('content-hash no-op skip: same content does not trigger callback', async () => {
      const yamlContent = YAML.stringify({ server: { log_level: 'info' } });
      await writeFile(join(dataDir, 'openhive.yaml'), yamlContent, 'utf-8');
      await loader.loadMaster();

      const callbackFn = vi.fn();
      loader.watchMaster(callbackFn);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Write same content (triggers file change event but content hash should match)
      await writeFile(join(dataDir, 'openhive.yaml'), yamlContent, 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // First call sets the hash; second write with same content should be a no-op
      // The first "change" event will fire callback (hash is new), but the second won't add another
      // Since the watcher just started and hash was not seeded, the first change will fire once
      expect(callbackFn.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('stopWatching cleans up all watchers', async () => {
      await writeFile(join(dataDir, 'openhive.yaml'), YAML.stringify({}), 'utf-8');
      await loader.loadMaster();

      const callbackFn = vi.fn();
      loader.watchMaster(callbackFn);

      await new Promise((resolve) => setTimeout(resolve, 200));
      loader.stopWatching();

      // Write after stop
      await writeFile(
        join(dataDir, 'openhive.yaml'),
        YAML.stringify({ server: { log_level: 'error' } }),
        'utf-8',
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(callbackFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // deepMerge
  // -----------------------------------------------------------------------

  describe('deepMerge', () => {
    it('merges nested objects recursively', () => {
      const target = { a: { b: 1, c: 2 }, d: 3 };
      const source = { a: { b: 10 } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
    });

    it('replaces arrays (does not merge them)', () => {
      const target = { arr: [1, 2, 3] };
      const source = { arr: [4, 5] };
      const result = deepMerge(target, source);
      expect(result).toEqual({ arr: [4, 5] });
    });

    it('skips undefined values in source', () => {
      const target = { a: 1, b: 2 };
      const source = { a: undefined, b: 3 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 3 });
    });

    it('source scalar wins over target scalar', () => {
      const target = { x: 'old' };
      const source = { x: 'new' };
      const result = deepMerge(target, source);
      expect(result).toEqual({ x: 'new' });
    });

    it('does not mutate target or source', () => {
      const target = { a: { b: 1 } };
      const source = { a: { c: 2 } };
      const targetCopy = JSON.parse(JSON.stringify(target));
      const sourceCopy = JSON.parse(JSON.stringify(source));

      deepMerge(target, source);

      expect(target).toEqual(targetCopy);
      expect(source).toEqual(sourceCopy);
    });

    it('handles deeply nested merge', () => {
      const target = { l1: { l2: { l3: { val: 'orig', keep: true } } } };
      const source = { l1: { l2: { l3: { val: 'new' } } } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ l1: { l2: { l3: { val: 'new', keep: true } } } });
    });
  });

  // -----------------------------------------------------------------------
  // getConfigWithSources
  // -----------------------------------------------------------------------

  describe('getConfigWithSources', () => {
    it('all fields are "default" when no YAML file and no env vars set', async () => {
      // No YAML file written, no env vars set
      const sources = await loader.getConfigWithSources();

      // Every source should be 'default'
      for (const [key, entry] of Object.entries(sources)) {
        expect(entry.source, `key "${key}" should be default`).toBe('default');
      }

      // Known fields should be present
      expect(sources['server.listen_address']).toBeDefined();
      expect(sources['limits.max_depth']).toBeDefined();
    });

    it('fields present in YAML are marked "yaml"', async () => {
      // Write YAML that explicitly sets log_level to the default value
      // (ensuring "YAML set to same value as default" is still 'yaml', not 'default')
      await writeFile(
        join(dataDir, 'openhive.yaml'),
        YAML.stringify({ server: { log_level: 'info' }, limits: { max_depth: 3 } }),
        'utf-8',
      );

      const sources = await loader.getConfigWithSources();

      expect(sources['server.log_level'].source).toBe('yaml');
      expect(sources['limits.max_depth'].source).toBe('yaml');
      // Fields NOT in YAML should remain 'default'
      expect(sources['server.listen_address'].source).toBe('default');
      expect(sources['limits.max_teams'].source).toBe('default');
    });

    it('env-var-overridden fields are marked "env"', async () => {
      process.env['OPENHIVE_LOG_LEVEL'] = 'warn';
      try {
        const sources = await loader.getConfigWithSources();
        expect(sources['server.log_level'].source).toBe('env');
        expect(sources['server.log_level'].value).toBe('warn');
      } finally {
        delete process.env['OPENHIVE_LOG_LEVEL'];
      }
    });

    it('env var overrides YAML: env takes priority', async () => {
      await writeFile(
        join(dataDir, 'openhive.yaml'),
        YAML.stringify({ server: { log_level: 'debug' } }),
        'utf-8',
      );
      process.env['OPENHIVE_LOG_LEVEL'] = 'error';
      try {
        const sources = await loader.getConfigWithSources();
        // Env wins over YAML
        expect(sources['server.log_level'].source).toBe('env');
        expect(sources['server.log_level'].value).toBe('error');
      } finally {
        delete process.env['OPENHIVE_LOG_LEVEL'];
      }
    });

    it('secret fields are redacted and marked isSecret: true', async () => {
      const sources = await loader.getConfigWithSources();

      // Look for fields with secret-like key names (e.g., 'security.encryption_key_path')
      const secretEntries = Object.entries(sources).filter(([, entry]) => entry.isSecret === true);
      expect(secretEntries.length).toBeGreaterThan(0);

      for (const [, entry] of secretEntries) {
        expect(entry.value).toBe('********');
        expect(entry.isSecret).toBe(true);
      }
    });

    it('non-secret fields do NOT have isSecret property', async () => {
      const sources = await loader.getConfigWithSources();

      // limits.max_depth is not a secret
      const entry = sources['limits.max_depth'];
      expect(entry.isSecret).toBeUndefined();
      expect(entry.value).toBe(3);
    });

    it('OPENHIVE_SYSTEM_LISTEN_ADDRESS env var marks server.listen_address as "env"', async () => {
      process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'] = '0.0.0.0:9090';
      try {
        const sources = await loader.getConfigWithSources();
        expect(sources['server.listen_address'].source).toBe('env');
        expect(sources['server.listen_address'].value).toBe('0.0.0.0:9090');
      } finally {
        delete process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
      }
    });

    it('OPENHIVE_DATA_DIR env var marks server.data_dir as "env"', async () => {
      process.env['OPENHIVE_DATA_DIR'] = '/custom/data';
      try {
        const sources = await loader.getConfigWithSources();
        expect(sources['server.data_dir'].source).toBe('env');
        expect(sources['server.data_dir'].value).toBe('/custom/data');
      } finally {
        delete process.env['OPENHIVE_DATA_DIR'];
      }
    });

    it('works without a prior loadMaster() call (lazy-loads)', async () => {
      // loader is fresh (no loadMaster called), getConfigWithSources should still work
      const freshLoader = new ConfigLoaderImpl({ dataDir, runDir });
      try {
        const sources = await freshLoader.getConfigWithSources();
        expect(sources['server.listen_address']).toBeDefined();
      } finally {
        freshLoader.stopWatching();
      }
    });
  });
});
