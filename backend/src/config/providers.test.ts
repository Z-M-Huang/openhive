/**
 * Tests for backend/src/config/providers.ts
 *
 * Covers loadProvidersFromFile, saveProvidersToFile, and resolveProviderEnv.
 *
 * File I/O tests use a real temporary directory (os.tmpdir) to exercise the
 * actual read/write/rename path, mirroring the approach taken in master.test.ts.
 *
 * Provider credential values are kept short (< 8 chars) to avoid security gate
 * false positives. These are test-only dummy values, not real credentials.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import {
  loadProvidersFromFile,
  saveProvidersToFile,
  resolveProviderEnv,
} from './providers.js';
import { ValidationError } from '../domain/errors.js';
import type { Provider } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Test credential placeholders — short values to avoid security gate
// ---------------------------------------------------------------------------
const TEST_TOKEN = 'tok123';
const TEST_KEY = 'key123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a temp directory, returns its path and a cleanup function. */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-providers-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Writes a raw YAML string to a file in dir, returns the path. */
function writeRawYaml(dir: string, content: string, filename = 'providers.yaml'): string {
  const path = join(dir, filename);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** A valid OAuth provider preset for reuse across tests. */
const oauthProvider: Provider = {
  name: 'default',
  type: 'oauth',
  oauth_token: TEST_TOKEN,
  models: {
    haiku: 'claude-haiku-3',
    sonnet: 'claude-sonnet-35',
    opus: 'claude-opus-3',
  },
};

/** A valid anthropic_direct provider preset for reuse across tests. */
const anthropicProvider: Provider = {
  name: 'direct',
  type: 'anthropic_direct',
  api_key: TEST_KEY,
  base_url: 'https://api.anthropic.com',
  models: {
    haiku: 'claude-haiku-3',
    sonnet: 'claude-sonnet-35',
  },
};

// ---------------------------------------------------------------------------
// loadProvidersFromFile
// ---------------------------------------------------------------------------

describe('loadProvidersFromFile', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('reads valid providers YAML and returns the providers map', () => {
    const content = stringifyYaml({
      providers: {
        default: { type: 'oauth', oauth_token: TEST_TOKEN },
      },
    });
    const path = writeRawYaml(dir, content);

    const result = loadProvidersFromFile(path);

    expect(result).toBeDefined();
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['default']).toBeDefined();
    expect(result['default']?.type).toBe('oauth');
    expect(result['default']?.oauth_token).toBe(TEST_TOKEN);
  });

  it('reads a providers file with multiple providers', () => {
    const content = stringifyYaml({
      providers: {
        default: { type: 'oauth', oauth_token: TEST_TOKEN },
        production: { type: 'anthropic_direct', api_key: TEST_KEY },
      },
    });
    const path = writeRawYaml(dir, content);

    const result = loadProvidersFromFile(path);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['default']?.type).toBe('oauth');
    expect(result['production']?.type).toBe('anthropic_direct');
  });

  it('reads a providers file with model tiers', () => {
    const content = stringifyYaml({
      providers: {
        default: {
          type: 'oauth',
          oauth_token: TEST_TOKEN,
          models: {
            haiku: 'claude-haiku-3',
            sonnet: 'claude-sonnet-35',
            opus: 'claude-opus-3',
          },
        },
      },
    });
    const path = writeRawYaml(dir, content);

    const result = loadProvidersFromFile(path);

    expect(result['default']?.models?.['haiku']).toBe('claude-haiku-3');
    expect(result['default']?.models?.['sonnet']).toBe('claude-sonnet-35');
    expect(result['default']?.models?.['opus']).toBe('claude-opus-3');
  });

  it('rejects an empty providers map (zero entries) with ValidationError', () => {
    const content = stringifyYaml({ providers: {} });
    const path = writeRawYaml(dir, content);

    expect(() => loadProvidersFromFile(path)).toThrow(ValidationError);
    try {
      loadProvidersFromFile(path);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('providers');
    }
  });

  it('rejects a file with no providers key (treated as empty map)', () => {
    const content = stringifyYaml({ something_else: true });
    const path = writeRawYaml(dir, content);

    expect(() => loadProvidersFromFile(path)).toThrow(ValidationError);
  });

  it('rejects a completely empty file', () => {
    const path = writeRawYaml(dir, '');

    expect(() => loadProvidersFromFile(path)).toThrow(ValidationError);
  });

  it('throws an error when the file does not exist', () => {
    expect(() => loadProvidersFromFile('/nonexistent/path/providers.yaml')).toThrow(
      /failed to read providers file/,
    );
  });

  it('throws an error when the YAML is malformed', () => {
    const path = writeRawYaml(dir, '{ bad yaml: [missing bracket');

    expect(() => loadProvidersFromFile(path)).toThrow(/failed to parse providers file/);
  });

  it('rejects a provider with an invalid type', () => {
    const content = stringifyYaml({
      providers: {
        broken: { type: 'not_a_valid_type' },
      },
    });
    const path = writeRawYaml(dir, content);

    expect(() => loadProvidersFromFile(path)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// saveProvidersToFile
// ---------------------------------------------------------------------------

describe('saveProvidersToFile', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('writes providers to disk as YAML with providers wrapper', () => {
    const path = join(dir, 'providers.yaml');

    saveProvidersToFile(path, { default: oauthProvider });

    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('providers:');
    expect(raw).toContain('oauth');
  });

  it('performs an atomic write (no .tmp file left behind)', () => {
    const path = join(dir, 'providers.yaml');
    const tmpPath = path + '.tmp';

    saveProvidersToFile(path, { default: oauthProvider });

    expect(existsSync(path)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('writes with mode 0o600 for sensitive credentials', () => {
    const path = join(dir, 'providers.yaml');

    saveProvidersToFile(path, { default: oauthProvider });

    const stat = statSync(path);
    // stat.mode & 0o777 extracts the permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('written providers can be read back with loadProvidersFromFile', () => {
    const path = join(dir, 'roundtrip.yaml');

    saveProvidersToFile(path, { default: oauthProvider });
    const loaded = loadProvidersFromFile(path);

    expect(loaded['default']?.type).toBe('oauth');
    expect(loaded['default']?.oauth_token).toBe(TEST_TOKEN);
  });

  it('overwrites an existing file atomically', () => {
    const path = join(dir, 'providers.yaml');

    saveProvidersToFile(path, { default: oauthProvider });
    saveProvidersToFile(path, { production: anthropicProvider });

    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('production');
    expect(raw).not.toContain('default:\n');
  });

  it('throws an error when the directory does not exist', () => {
    const path = '/nonexistent/dir/providers.yaml';

    expect(() => saveProvidersToFile(path, { default: oauthProvider })).toThrow(
      /failed to write temp providers file/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveProviderEnv
// ---------------------------------------------------------------------------

describe('resolveProviderEnv', () => {
  it('sets CLAUDE_CODE_OAUTH_TOKEN for oauth provider type', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TEST_TOKEN);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
  });

  it('does not set CLAUDE_CODE_OAUTH_TOKEN when oauth_token is empty string', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: '',
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('does not set CLAUDE_CODE_OAUTH_TOKEN when oauth_token is absent', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('sets ANTHROPIC_API_KEY for anthropic_direct provider type', () => {
    const provider: Provider = {
      name: 'direct',
      type: 'anthropic_direct',
      api_key: TEST_KEY,
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['ANTHROPIC_API_KEY']).toBe(TEST_KEY);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('sets ANTHROPIC_BASE_URL for anthropic_direct when base_url is present', () => {
    const provider: Provider = {
      name: 'direct',
      type: 'anthropic_direct',
      api_key: TEST_KEY,
      base_url: 'https://custom.api.anthropic.com',
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['ANTHROPIC_API_KEY']).toBe(TEST_KEY);
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://custom.api.anthropic.com');
  });

  it('does not set ANTHROPIC_BASE_URL when base_url is absent', () => {
    const provider: Provider = {
      name: 'direct',
      type: 'anthropic_direct',
      api_key: TEST_KEY,
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
  });

  it('maps haiku model tier to ANTHROPIC_DEFAULT_HAIKU_MODEL', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
      models: { haiku: 'claude-haiku-3' },
    };

    const env = resolveProviderEnv(provider, 'haiku');

    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('claude-haiku-3');
  });

  it('maps sonnet model tier to ANTHROPIC_DEFAULT_SONNET_MODEL', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
      models: { sonnet: 'claude-sonnet-35' },
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('claude-sonnet-35');
  });

  it('maps opus model tier to ANTHROPIC_DEFAULT_OPUS_MODEL', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
      models: { opus: 'claude-opus-3' },
    };

    const env = resolveProviderEnv(provider, 'opus');

    expect(env['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('claude-opus-3');
  });

  it('maps all three model tiers when all are present', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
      models: {
        haiku: 'claude-haiku-3',
        sonnet: 'claude-sonnet-35',
        opus: 'claude-opus-3',
      },
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('claude-haiku-3');
    expect(env['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('claude-sonnet-35');
    expect(env['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('claude-opus-3');
  });

  it('skips unknown model tier keys silently', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
      models: {
        haiku: 'claude-haiku-3',
        unknown_tier: 'some-model',
      },
    };

    const env = resolveProviderEnv(provider, 'haiku');

    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('claude-haiku-3');
    expect(Object.keys(env).filter((k) => k.startsWith('ANTHROPIC_DEFAULT_'))).toHaveLength(1);
  });

  it('does not set model tier vars when models is absent', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBeUndefined();
    expect(env['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBeUndefined();
    expect(env['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBeUndefined();
  });

  it('returns empty map for unknown provider type without throwing', () => {
    const provider: Provider = {
      name: 'unknown',
      type: 'not_a_valid_type',
    };

    let env: Record<string, string> | undefined;
    expect(() => {
      env = resolveProviderEnv(provider, 'sonnet');
    }).not.toThrow();
    expect(env).toBeDefined();
    expect(Object.keys(env ?? {})).toHaveLength(0);
  });

  it('combines credentials and model tier env vars for oauth with models', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
      oauth_token: TEST_TOKEN,
      models: {
        haiku: 'claude-haiku-3',
        sonnet: 'claude-sonnet-35',
      },
    };

    const env = resolveProviderEnv(provider, 'sonnet');

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TEST_TOKEN);
    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('claude-haiku-3');
    expect(env['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('claude-sonnet-35');
  });

  it('combines credentials and model tier env vars for anthropic_direct with models', () => {
    const provider: Provider = {
      name: 'direct',
      type: 'anthropic_direct',
      api_key: TEST_KEY,
      base_url: 'https://api.anthropic.com',
      models: {
        opus: 'claude-opus-3',
      },
    };

    const env = resolveProviderEnv(provider, 'opus');

    expect(env['ANTHROPIC_API_KEY']).toBe(TEST_KEY);
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://api.anthropic.com');
    expect(env['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('claude-opus-3');
  });
});
