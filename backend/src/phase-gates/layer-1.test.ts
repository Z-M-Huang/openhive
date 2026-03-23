/**
 * Layer 1 Phase Gate — Config + Logging + Secrets
 *
 * UT-11: SecretString expose/redaction
 * UT-12: Secret resolver loading and path traversal rejection
 * UT-1:  Config loader validation and fail-fast
 * UT-13: Credential scrubber known values and patterns
 * UT-24: Logger smoke test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { SecretString } from '../secrets/secret-string.js';
import { resolveSecrets } from '../secrets/resolver.js';
import { loadTeamConfig, loadProviders, loadTriggers, loadLogging } from '../config/loader.js';
import { scrubSecrets, createStderrScrubber } from '../logging/credential-scrubber.js';
import { createLogger } from '../logging/logger.js';
import { ConfigError, ValidationError } from '../domain/errors.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-test-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── UT-11: SecretString ────────────────────────────────────────────────────

describe('UT-11: SecretString', () => {
  const raw = 'super-secret-api-key-12345';
  const secret = new SecretString(raw);

  it('expose() returns the raw value', () => {
    expect(secret.expose()).toBe(raw);
  });

  it('toString() returns [REDACTED]', () => {
    expect(secret.toString()).toBe('[REDACTED]');
  });

  it('toJSON() returns [REDACTED]', () => {
    expect(secret.toJSON()).toBe('[REDACTED]');
    expect(JSON.stringify({ key: secret })).toBe('{"key":"[REDACTED]"}');
  });

  it('Symbol.toPrimitive returns [REDACTED]', () => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`${secret}`).toBe('[REDACTED]');
  });

  it('util.inspect returns [REDACTED]', () => {
    expect(inspect(secret)).toBe('[REDACTED]');
  });

  it('prototype is frozen', () => {
    expect(Object.isFrozen(SecretString.prototype)).toBe(true);
  });

  it('instance is frozen', () => {
    expect(Object.isFrozen(secret)).toBe(true);
  });
});

// ── UT-12: Secret Resolver ─────────────────────────────────────────────────

describe('UT-12: Secret Resolver', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('loads .env file with KEY=VALUE pairs', () => {
    writeFileSync(join(tmpDir, 'global.env'), 'GLOBAL_KEY=global-value\n');
    writeFileSync(join(tmpDir, 'myteam.env'), 'TEAM_KEY=team-value\n');
    const secrets = resolveSecrets('myteam', tmpDir);
    expect(secrets.get('GLOBAL_KEY')?.expose()).toBe('global-value');
    expect(secrets.get('TEAM_KEY')?.expose()).toBe('team-value');
  });

  it('team secrets override global secrets', () => {
    writeFileSync(join(tmpDir, 'global.env'), 'SHARED=from-global\n');
    writeFileSync(join(tmpDir, 'myteam.env'), 'SHARED=from-team\n');
    const secrets = resolveSecrets('myteam', tmpDir);
    expect(secrets.get('SHARED')?.expose()).toBe('from-team');
  });

  it('skips empty lines and comments', () => {
    writeFileSync(
      join(tmpDir, 'global.env'),
      '# comment\n\nKEY=val\n  \n# another\n',
    );
    const secrets = resolveSecrets('myteam', tmpDir);
    expect(secrets.size).toBe(1);
    expect(secrets.get('KEY')?.expose()).toBe('val');
  });

  it('handles missing files gracefully', () => {
    const secrets = resolveSecrets('myteam', tmpDir);
    expect(secrets.size).toBe(0);
  });

  it('rejects path traversal in team slug', () => {
    expect(() => resolveSecrets('../etc', tmpDir)).toThrow(ValidationError);
  });

  it('rejects invalid slug format', () => {
    expect(() => resolveSecrets('UPPER_CASE', tmpDir)).toThrow(ValidationError);
    expect(() => resolveSecrets('has spaces', tmpDir)).toThrow(ValidationError);
    expect(() => resolveSecrets('', tmpDir)).toThrow(ValidationError);
  });
});

// ── UT-1: Config Loader ────────────────────────────────────────────────────

describe('UT-1: Config Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('loadTeamConfig validates valid YAML', () => {
    const yaml = `
name: weather-team
provider_profile: default-sonnet
description: Handles weather queries
scope:
  accepts: ["weather", "forecast"]
  rejects: []
`;
    const file = join(tmpDir, 'team.yaml');
    writeFileSync(file, yaml);
    const config = loadTeamConfig(file);
    expect(config.name).toBe('weather-team');
    expect(config.maxTurns).toBe(50); // default
    expect(config.parent).toBeNull();
  });

  it('loadTeamConfig rejects missing required fields', () => {
    const yaml = `description: no name or profile`;
    const file = join(tmpDir, 'team.yaml');
    writeFileSync(file, yaml);
    expect(() => loadTeamConfig(file)).toThrow(ConfigError);
  });

  it('loadProviders validates valid YAML', () => {
    const yaml = `
profiles:
  sonnet:
    type: api
    api_key_ref: ANTHROPIC_KEY
    model: claude-sonnet-4-20250514
`;
    const file = join(tmpDir, 'providers.yaml');
    writeFileSync(file, yaml);
    const result = loadProviders(file);
    expect(result.profiles['sonnet']?.type).toBe('api');
  });

  it('loadProviders rejects invalid provider type', () => {
    const yaml = `
profiles:
  bad:
    type: invalid
`;
    const file = join(tmpDir, 'providers.yaml');
    writeFileSync(file, yaml);
    expect(() => loadProviders(file)).toThrow(ConfigError);
  });

  it('loadTriggers validates valid YAML', () => {
    const yaml = `
triggers:
  - name: daily-check
    type: schedule
    config:
      cron: "0 9 * * *"
    team: weather
    task: health check
`;
    const file = join(tmpDir, 'triggers.yaml');
    writeFileSync(file, yaml);
    const result = loadTriggers(file);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0]?.name).toBe('daily-check');
  });

  it('loadLogging validates and applies defaults', () => {
    const yaml = `level: debug`;
    const file = join(tmpDir, 'logging.yaml');
    writeFileSync(file, yaml);
    const result = loadLogging(file);
    expect(result.level).toBe('debug');
    expect(result.retention).toBeUndefined();
  });

  it('throws ConfigError for nonexistent file', () => {
    expect(() => loadTeamConfig('/nonexistent/file.yaml')).toThrow(ConfigError);
  });

  it('throws ConfigError for invalid YAML syntax', () => {
    const file = join(tmpDir, 'bad.yaml');
    writeFileSync(file, '{{{{invalid yaml');
    expect(() => loadTeamConfig(file)).toThrow(ConfigError);
  });
});

// ── UT-13: Credential Scrubber ─────────────────────────────────────────────

describe('UT-13: Credential Scrubber', () => {
  it('scrubs known secret values', () => {
    const secret = new SecretString('my-api-key-12345');
    const text = 'Authorization: my-api-key-12345 is used here';
    const scrubbed = scrubSecrets(text, [secret]);
    expect(scrubbed).not.toContain('my-api-key-12345');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs sk- prefixed keys', () => {
    const text = 'key is sk-abcdefghijklmnopqrstuvwxyz in logs';
    const scrubbed = scrubSecrets(text, []);
    expect(scrubbed).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs Bearer tokens', () => {
    const text = 'Header: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const scrubbed = scrubSecrets(text, []);
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs token= parameters', () => {
    const text = 'url?token=abc123def456&foo=bar';
    const scrubbed = scrubSecrets(text, []);
    expect(scrubbed).not.toContain('token=abc123def456');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('handles empty secrets list', () => {
    const text = 'no secrets here';
    expect(scrubSecrets(text, [])).toBe('no secrets here');
  });

  it('createStderrScrubber returns a working scrubber', () => {
    const secret = new SecretString('secret-val');
    const scrubber = createStderrScrubber([secret]);
    const result = scrubber('error: secret-val leaked');
    expect(result).not.toContain('secret-val');
    expect(result).toContain('[REDACTED]');
  });
});

// ── UT-24: Logger Smoke Test ───────────────────────────────────────────────

describe('UT-24: Logger', () => {
  it('creates a logger with default level', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('creates a logger with custom level', () => {
    const logger = createLogger({ level: 'debug' });
    expect(logger.level).toBe('debug');
  });

  it('logger has standard methods', () => {
    const logger = createLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.trace).toBe('function');
  });
});
