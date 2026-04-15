/**
 * Config loader tests (migrated from layer-1.test.ts)
 *
 * UT-1: Config loader validation and fail-fast
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { loadTeamConfig, loadProviders, loadTriggers, loadLogging } from './loader.js';
import { ConfigError } from '../domain/errors.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-test-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
`;
    const file = join(tmpDir, 'team.yaml');
    writeFileSync(file, yaml);
    const config = loadTeamConfig(file);
    expect(config.name).toBe('weather-team');
    expect(config.maxSteps).toBe(50); // default
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
    api_key: sk-test-placeholder
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
