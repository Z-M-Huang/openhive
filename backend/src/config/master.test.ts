/**
 * Tests for backend/src/config/master.ts
 *
 * Covers loadMasterFromFile, saveMasterToFile, getConfigSection,
 * getConfigSectionByName, updateConfigField, and applyEnvOverrides.
 *
 * File I/O tests use a real temporary directory (os.tmpdir) to exercise the
 * actual read/write/rename path, mirroring the approach taken by Go tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import {
  loadMasterFromFile,
  saveMasterToFile,
  getConfigSection,
  getConfigSectionByName,
  updateConfigField,
  applyEnvOverrides,
} from './master.js';
import { defaultMasterConfig } from './defaults.js';
import { ValidationError } from '../domain/errors.js';
import { NotFoundError } from '../domain/errors.js';
import type { MasterConfig } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a temp directory, returns its path and a cleanup function. */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-master-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Writes a MasterConfig as YAML to a file in dir, returns the path. */
function writeConfigFile(dir: string, cfg: Partial<MasterConfig>, filename = 'openhive.yaml'): string {
  const path = join(dir, filename);
  writeFileSync(path, stringifyYaml(cfg), 'utf8');
  return path;
}

/** Writes a raw YAML string to a file in dir, returns the path. */
function writeRawYaml(dir: string, content: string, filename = 'openhive.yaml'): string {
  const path = join(dir, filename);
  writeFileSync(path, content, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// loadMasterFromFile
// ---------------------------------------------------------------------------

describe('loadMasterFromFile', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
    // Clear any env overrides that could interfere.
    delete process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
    delete process.env['OPENHIVE_SYSTEM_DATA_DIR'];
    delete process.env['OPENHIVE_SYSTEM_WORKSPACE_ROOT'];
    delete process.env['OPENHIVE_SYSTEM_LOG_LEVEL'];
    delete process.env['OPENHIVE_ASSISTANT_NAME'];
    delete process.env['OPENHIVE_ASSISTANT_AID'];
    delete process.env['OPENHIVE_ASSISTANT_PROVIDER'];
    delete process.env['OPENHIVE_ASSISTANT_MODEL_TIER'];
  });

  afterEach(() => {
    cleanup();
    // Restore env.
    delete process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
    delete process.env['OPENHIVE_SYSTEM_DATA_DIR'];
    delete process.env['OPENHIVE_SYSTEM_WORKSPACE_ROOT'];
    delete process.env['OPENHIVE_SYSTEM_LOG_LEVEL'];
    delete process.env['OPENHIVE_ASSISTANT_NAME'];
    delete process.env['OPENHIVE_ASSISTANT_AID'];
    delete process.env['OPENHIVE_ASSISTANT_PROVIDER'];
    delete process.env['OPENHIVE_ASSISTANT_MODEL_TIER'];
  });

  it('reads and parses a valid YAML config file', () => {
    const cfg = defaultMasterConfig();
    cfg.system.listen_address = '0.0.0.0:9090';
    const path = writeConfigFile(dir, cfg);

    const result = loadMasterFromFile(path);
    expect(result.system.listen_address).toBe('0.0.0.0:9090');
  });

  it('returns a complete MasterConfig object for a minimal YAML file', () => {
    // Only override one field; all others should come from defaults.
    const minimal = { system: { listen_address: '0.0.0.0:7777' } };
    const path = writeRawYaml(dir, stringifyYaml(minimal));

    const result = loadMasterFromFile(path);
    expect(result.system.listen_address).toBe('0.0.0.0:7777');
    // Non-overridden fields stay at defaults.
    expect(result.system.data_dir).toBe('data');
    expect(result.system.workspace_root).toBe('/openhive/workspace');
    expect(result.assistant.name).toBe('OpenHive Assistant');
    expect(result.assistant.provider).toBe('default');
  });

  it('applies defaults for all fields missing from the YAML file', () => {
    const defaults = defaultMasterConfig();
    // Write an empty YAML file (null parse result).
    const path = writeRawYaml(dir, '');

    const result = loadMasterFromFile(path);
    expect(result.system.listen_address).toBe(defaults.system.listen_address);
    expect(result.system.data_dir).toBe(defaults.system.data_dir);
    expect(result.assistant.name).toBe(defaults.assistant.name);
    expect(result.channels.discord.enabled).toBe(false);
    expect(result.channels.whatsapp.enabled).toBe(false);
  });

  it('applies default log_archive values when log_archive is absent in YAML', () => {
    const path = writeRawYaml(dir, 'system:\n  listen_address: "127.0.0.1:8080"\n');
    const result = loadMasterFromFile(path);
    expect(result.system.log_archive.enabled).toBe(true);
    expect(result.system.log_archive.max_entries).toBe(100000);
    expect(result.system.log_archive.keep_copies).toBe(5);
  });

  it('applies env var overrides after YAML is parsed', () => {
    process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'] = '0.0.0.0:5555';
    process.env['OPENHIVE_SYSTEM_LOG_LEVEL'] = 'debug';
    process.env['OPENHIVE_ASSISTANT_MODEL_TIER'] = 'haiku';

    const path = writeConfigFile(dir, defaultMasterConfig());
    const result = loadMasterFromFile(path);

    expect(result.system.listen_address).toBe('0.0.0.0:5555');
    expect(result.system.log_level).toBe('debug');
    expect(result.assistant.model_tier).toBe('haiku');
  });

  it('env var overrides take precedence over YAML values', () => {
    const cfg = defaultMasterConfig();
    cfg.system.listen_address = '1.2.3.4:8080';
    writeConfigFile(dir, cfg, 'openhive.yaml');
    const path = join(dir, 'openhive.yaml');

    process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'] = '0.0.0.0:9999';
    const result = loadMasterFromFile(path);
    expect(result.system.listen_address).toBe('0.0.0.0:9999');
  });

  it('validates the config after loading and throws on invalid config', () => {
    // A YAML that sets listen_address to empty — validation must reject it.
    const path = writeRawYaml(
      dir,
      'system:\n  listen_address: ""\n  data_dir: data\n  workspace_root: /ws\n',
    );
    expect(() => loadMasterFromFile(path)).toThrow(ValidationError);
  });

  it('throws an error when the file does not exist', () => {
    expect(() => loadMasterFromFile('/nonexistent/path/openhive.yaml')).toThrow(
      /failed to read config file/,
    );
  });

  it('throws an error when the YAML is malformed', () => {
    const path = writeRawYaml(dir, '{ bad yaml: [missing bracket');
    expect(() => loadMasterFromFile(path)).toThrow(/failed to parse config file/);
  });

  it('preserves nested channel config from YAML', () => {
    const path = writeRawYaml(
      dir,
      'channels:\n  discord:\n    enabled: true\n    token: testtoken\n',
    );
    const result = loadMasterFromFile(path);
    expect(result.channels.discord.enabled).toBe(true);
    expect(result.channels.discord.token).toBe('testtoken');
    // whatsapp stays at default.
    expect(result.channels.whatsapp.enabled).toBe(false);
  });

  it('applies all 8 env var overrides simultaneously', () => {
    process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'] = '127.0.0.1:1111';
    process.env['OPENHIVE_SYSTEM_DATA_DIR'] = '/custom/data';
    process.env['OPENHIVE_SYSTEM_WORKSPACE_ROOT'] = '/custom/ws';
    process.env['OPENHIVE_SYSTEM_LOG_LEVEL'] = 'warn';
    process.env['OPENHIVE_ASSISTANT_NAME'] = 'CustomBot';
    process.env['OPENHIVE_ASSISTANT_AID'] = 'aid-cust-001';
    process.env['OPENHIVE_ASSISTANT_PROVIDER'] = 'custom-provider';
    process.env['OPENHIVE_ASSISTANT_MODEL_TIER'] = 'opus';

    const path = writeConfigFile(dir, defaultMasterConfig());
    const result = loadMasterFromFile(path);

    expect(result.system.listen_address).toBe('127.0.0.1:1111');
    expect(result.system.data_dir).toBe('/custom/data');
    expect(result.system.workspace_root).toBe('/custom/ws');
    expect(result.system.log_level).toBe('warn');
    expect(result.assistant.name).toBe('CustomBot');
    expect(result.assistant.aid).toBe('aid-cust-001');
    expect(result.assistant.provider).toBe('custom-provider');
    expect(result.assistant.model_tier).toBe('opus');
  });
});

// ---------------------------------------------------------------------------
// saveMasterToFile
// ---------------------------------------------------------------------------

describe('saveMasterToFile', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('writes a valid MasterConfig to disk as YAML', () => {
    const cfg = defaultMasterConfig();
    cfg.system.listen_address = '0.0.0.0:4000';
    const path = join(dir, 'output.yaml');

    saveMasterToFile(path, cfg);

    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('0.0.0.0:4000');
  });

  it('performs an atomic write (no .tmp file left behind)', () => {
    const cfg = defaultMasterConfig();
    const path = join(dir, 'output.yaml');
    const tmpPath = path + '.tmp';

    saveMasterToFile(path, cfg);

    expect(existsSync(path)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('written config can be read back with loadMasterFromFile', () => {
    // Clear env overrides.
    delete process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
    delete process.env['OPENHIVE_SYSTEM_DATA_DIR'];
    delete process.env['OPENHIVE_SYSTEM_WORKSPACE_ROOT'];
    delete process.env['OPENHIVE_SYSTEM_LOG_LEVEL'];
    delete process.env['OPENHIVE_ASSISTANT_NAME'];
    delete process.env['OPENHIVE_ASSISTANT_AID'];
    delete process.env['OPENHIVE_ASSISTANT_PROVIDER'];
    delete process.env['OPENHIVE_ASSISTANT_MODEL_TIER'];

    const cfg = defaultMasterConfig();
    cfg.system.listen_address = '0.0.0.0:7070';
    cfg.system.log_level = 'warn';
    const path = join(dir, 'roundtrip.yaml');

    saveMasterToFile(path, cfg);
    const loaded = loadMasterFromFile(path);

    expect(loaded.system.listen_address).toBe('0.0.0.0:7070');
    expect(loaded.system.log_level).toBe('warn');
    expect(loaded.assistant.name).toBe(cfg.assistant.name);
  });

  it('overwrites an existing file atomically', () => {
    const path = join(dir, 'output.yaml');
    // Write once.
    const cfg1 = defaultMasterConfig();
    cfg1.system.listen_address = '127.0.0.1:1000';
    saveMasterToFile(path, cfg1);

    // Overwrite.
    const cfg2 = defaultMasterConfig();
    cfg2.system.listen_address = '127.0.0.1:2000';
    saveMasterToFile(path, cfg2);

    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('127.0.0.1:2000');
    expect(raw).not.toContain('127.0.0.1:1000');
  });

  it('throws an error when the directory does not exist', () => {
    const path = '/nonexistent/dir/openhive.yaml';
    const cfg = defaultMasterConfig();
    expect(() => saveMasterToFile(path, cfg)).toThrow(/failed to write temp config file/);
  });
});

// ---------------------------------------------------------------------------
// getConfigSection
// ---------------------------------------------------------------------------

describe('getConfigSection', () => {
  it('returns the system section', () => {
    const cfg = defaultMasterConfig();
    const section = getConfigSection(cfg, 'system');
    expect(section.listen_address).toBe(cfg.system.listen_address);
  });

  it('returns the assistant section', () => {
    const cfg = defaultMasterConfig();
    const section = getConfigSection(cfg, 'assistant');
    expect(section.name).toBe(cfg.assistant.name);
    expect(section.aid).toBe(cfg.assistant.aid);
  });

  it('returns the agents section as an empty array when agents is undefined', () => {
    const cfg = defaultMasterConfig();
    const section = getConfigSection(cfg, 'agents');
    expect(Array.isArray(section)).toBe(true);
    expect(section).toHaveLength(0);
  });

  it('returns the agents section when agents are defined', () => {
    const cfg = defaultMasterConfig();
    cfg.agents = [{ aid: 'aid-lead-001', name: 'lead' }];
    const section = getConfigSection(cfg, 'agents');
    expect(section).toHaveLength(1);
    expect(section[0]?.aid).toBe('aid-lead-001');
  });

  it('returns the channels section', () => {
    const cfg = defaultMasterConfig();
    const section = getConfigSection(cfg, 'channels');
    expect(section.discord.enabled).toBe(false);
    expect(section.whatsapp.enabled).toBe(false);
  });

  it('returns the same object reference (not a copy)', () => {
    const cfg = defaultMasterConfig();
    const system = getConfigSection(cfg, 'system');
    expect(system).toBe(cfg.system);
  });
});

// ---------------------------------------------------------------------------
// getConfigSectionByName
// ---------------------------------------------------------------------------

describe('getConfigSectionByName', () => {
  it('returns system section for "system"', () => {
    const cfg = defaultMasterConfig();
    const result = getConfigSectionByName(cfg, 'system');
    expect(result).toBe(cfg.system);
  });

  it('returns assistant section for "assistant"', () => {
    const cfg = defaultMasterConfig();
    const result = getConfigSectionByName(cfg, 'assistant');
    expect(result).toBe(cfg.assistant);
  });

  it('returns empty array for "agents" when agents is undefined', () => {
    const cfg = defaultMasterConfig();
    const result = getConfigSectionByName(cfg, 'agents');
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns channels section for "channels"', () => {
    const cfg = defaultMasterConfig();
    const result = getConfigSectionByName(cfg, 'channels');
    expect(result).toBe(cfg.channels);
  });

  it('throws NotFoundError for unknown section', () => {
    const cfg = defaultMasterConfig();
    expect(() => getConfigSectionByName(cfg, 'nonexistent')).toThrow(NotFoundError);
    try {
      getConfigSectionByName(cfg, 'nonexistent');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).resource).toBe('config section');
      expect((err as NotFoundError).id).toBe('nonexistent');
    }
  });

  it('throws NotFoundError for empty string section', () => {
    const cfg = defaultMasterConfig();
    expect(() => getConfigSectionByName(cfg, '')).toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// updateConfigField
// ---------------------------------------------------------------------------

describe('updateConfigField', () => {
  it('updates a top-level field in the system section', () => {
    const cfg = defaultMasterConfig();
    updateConfigField(cfg, 'system', 'listen_address', '0.0.0.0:9999');
    expect(cfg.system.listen_address).toBe('0.0.0.0:9999');
  });

  it('updates a top-level field in the assistant section', () => {
    const cfg = defaultMasterConfig();
    updateConfigField(cfg, 'assistant', 'name', 'MyBot');
    expect(cfg.assistant.name).toBe('MyBot');
  });

  it('updates a number field', () => {
    const cfg = defaultMasterConfig();
    updateConfigField(cfg, 'assistant', 'max_turns', 100);
    expect(cfg.assistant.max_turns).toBe(100);
  });

  it('updates a boolean field', () => {
    const cfg = defaultMasterConfig();
    updateConfigField(cfg, 'channels', 'discord.enabled', true);
    expect(cfg.channels.discord.enabled).toBe(true);
  });

  it('updates a nested field via dot-separated path', () => {
    const cfg = defaultMasterConfig();
    updateConfigField(cfg, 'system', 'log_archive.archive_dir', '/custom/archives');
    expect(cfg.system.log_archive.archive_dir).toBe('/custom/archives');
  });

  it('updates a nested numeric field via dot-separated path', () => {
    const cfg = defaultMasterConfig();
    updateConfigField(cfg, 'system', 'log_archive.max_entries', 50000);
    expect(cfg.system.log_archive.max_entries).toBe(50000);
  });

  it('updates a nested boolean field via dot-separated path', () => {
    const cfg = defaultMasterConfig();
    updateConfigField(cfg, 'system', 'log_archive.enabled', false);
    expect(cfg.system.log_archive.enabled).toBe(false);
  });

  it('throws ValidationError for empty path', () => {
    const cfg = defaultMasterConfig();
    expect(() => updateConfigField(cfg, 'system', '', 'val')).toThrow(ValidationError);
    try {
      updateConfigField(cfg, 'system', '', 'val');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('path');
    }
  });

  it('throws ValidationError for unknown section', () => {
    const cfg = defaultMasterConfig();
    expect(() => updateConfigField(cfg, 'nonexistent', 'field', 'val')).toThrow(ValidationError);
    try {
      updateConfigField(cfg, 'nonexistent', 'field', 'val');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('nonexistent');
    }
  });

  it('throws ValidationError for unknown top-level field in section', () => {
    const cfg = defaultMasterConfig();
    expect(() => updateConfigField(cfg, 'system', 'nonexistent_field', 'val')).toThrow(
      ValidationError,
    );
    try {
      updateConfigField(cfg, 'system', 'nonexistent_field', 'val');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).validationMessage).toContain('nonexistent_field');
    }
  });

  it('throws ValidationError for unknown nested field in dot path', () => {
    const cfg = defaultMasterConfig();
    expect(() => updateConfigField(cfg, 'system', 'log_archive.bogus_key', 'val')).toThrow(
      ValidationError,
    );
    try {
      updateConfigField(cfg, 'system', 'log_archive.bogus_key', 'val');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).validationMessage).toContain('bogus_key');
    }
  });

  it('throws ValidationError for type mismatch (string into number field)', () => {
    const cfg = defaultMasterConfig();
    expect(() => updateConfigField(cfg, 'assistant', 'max_turns', 'not-a-number')).toThrow(
      ValidationError,
    );
    try {
      updateConfigField(cfg, 'assistant', 'max_turns', 'not-a-number');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).validationMessage).toContain('type mismatch');
    }
  });

  it('throws ValidationError for type mismatch (number into string field)', () => {
    const cfg = defaultMasterConfig();
    expect(() => updateConfigField(cfg, 'system', 'listen_address', 8080)).toThrow(ValidationError);
  });

  it('throws ValidationError for type mismatch (string into boolean field)', () => {
    const cfg = defaultMasterConfig();
    expect(() => updateConfigField(cfg, 'channels', 'discord.enabled', 'true')).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when traversing a non-object intermediate field', () => {
    const cfg = defaultMasterConfig();
    // 'listen_address' is a string, not an object — cannot traverse into it.
    expect(() =>
      updateConfigField(cfg, 'system', 'listen_address.sub_field', 'val'),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// applyEnvOverrides
// ---------------------------------------------------------------------------

describe('applyEnvOverrides', () => {
  beforeEach(() => {
    delete process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
    delete process.env['OPENHIVE_SYSTEM_DATA_DIR'];
    delete process.env['OPENHIVE_SYSTEM_WORKSPACE_ROOT'];
    delete process.env['OPENHIVE_SYSTEM_LOG_LEVEL'];
    delete process.env['OPENHIVE_ASSISTANT_NAME'];
    delete process.env['OPENHIVE_ASSISTANT_AID'];
    delete process.env['OPENHIVE_ASSISTANT_PROVIDER'];
    delete process.env['OPENHIVE_ASSISTANT_MODEL_TIER'];
  });

  afterEach(() => {
    delete process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
    delete process.env['OPENHIVE_SYSTEM_DATA_DIR'];
    delete process.env['OPENHIVE_SYSTEM_WORKSPACE_ROOT'];
    delete process.env['OPENHIVE_SYSTEM_LOG_LEVEL'];
    delete process.env['OPENHIVE_ASSISTANT_NAME'];
    delete process.env['OPENHIVE_ASSISTANT_AID'];
    delete process.env['OPENHIVE_ASSISTANT_PROVIDER'];
    delete process.env['OPENHIVE_ASSISTANT_MODEL_TIER'];
  });

  it('does not change config when no env vars are set', () => {
    const cfg = defaultMasterConfig();
    const original = JSON.parse(JSON.stringify(cfg)) as MasterConfig;
    applyEnvOverrides(cfg);
    expect(cfg.system.listen_address).toBe(original.system.listen_address);
    expect(cfg.assistant.name).toBe(original.assistant.name);
  });

  it('overrides system.listen_address from OPENHIVE_SYSTEM_LISTEN_ADDRESS', () => {
    process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'] = '0.0.0.0:9000';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.system.listen_address).toBe('0.0.0.0:9000');
  });

  it('overrides system.data_dir from OPENHIVE_SYSTEM_DATA_DIR', () => {
    process.env['OPENHIVE_SYSTEM_DATA_DIR'] = '/env/data';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.system.data_dir).toBe('/env/data');
  });

  it('overrides system.workspace_root from OPENHIVE_SYSTEM_WORKSPACE_ROOT', () => {
    process.env['OPENHIVE_SYSTEM_WORKSPACE_ROOT'] = '/env/ws';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.system.workspace_root).toBe('/env/ws');
  });

  it('overrides system.log_level from OPENHIVE_SYSTEM_LOG_LEVEL', () => {
    process.env['OPENHIVE_SYSTEM_LOG_LEVEL'] = 'error';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.system.log_level).toBe('error');
  });

  it('overrides assistant.name from OPENHIVE_ASSISTANT_NAME', () => {
    process.env['OPENHIVE_ASSISTANT_NAME'] = 'EnvBot';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.assistant.name).toBe('EnvBot');
  });

  it('overrides assistant.aid from OPENHIVE_ASSISTANT_AID', () => {
    process.env['OPENHIVE_ASSISTANT_AID'] = 'aid-env0-001';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.assistant.aid).toBe('aid-env0-001');
  });

  it('overrides assistant.provider from OPENHIVE_ASSISTANT_PROVIDER', () => {
    process.env['OPENHIVE_ASSISTANT_PROVIDER'] = 'env-provider';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.assistant.provider).toBe('env-provider');
  });

  it('overrides assistant.model_tier from OPENHIVE_ASSISTANT_MODEL_TIER', () => {
    process.env['OPENHIVE_ASSISTANT_MODEL_TIER'] = 'haiku';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    expect(cfg.assistant.model_tier).toBe('haiku');
  });

  it('does not override fields when env var is set to empty string', () => {
    process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'] = '';
    const cfg = defaultMasterConfig();
    const original = cfg.system.listen_address;
    applyEnvOverrides(cfg);
    expect(cfg.system.listen_address).toBe(original);
  });

  it('only overrides set env vars, leaves others at their current values', () => {
    process.env['OPENHIVE_SYSTEM_LOG_LEVEL'] = 'debug';
    const cfg = defaultMasterConfig();
    applyEnvOverrides(cfg);
    // Only log_level changed.
    expect(cfg.system.log_level).toBe('debug');
    expect(cfg.system.listen_address).toBe('127.0.0.1:8080');
    expect(cfg.assistant.name).toBe('OpenHive Assistant');
  });
});
