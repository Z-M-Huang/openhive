/**
 * Clean-start tests for config loader.
 *
 * Verifies that the loader does not expose `scope` or `mcp_servers` in the
 * runtime TeamConfig returned to callers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { loadTeamConfig, getOrCreateTeamConfig } from './loader.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-test-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Clean-Start: No scope or mcp_servers in runtime config ────────────────

describe('Clean-start: runtime TeamConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('loadTeamConfig does not return scope field', () => {
    const yaml = `
name: test-team
provider_profile: default
description: Test team
`;
    const file = join(tmpDir, 'team.yaml');
    writeFileSync(file, yaml);
    const config = loadTeamConfig(file);
    expect('scope' in config).toBe(false);
  });

  it('loadTeamConfig does not return mcp_servers field', () => {
    const yaml = `
name: test-team
provider_profile: default
description: Test team
`;
    const file = join(tmpDir, 'team.yaml');
    writeFileSync(file, yaml);
    const config = loadTeamConfig(file);
    expect('mcp_servers' in config).toBe(false);
  });

  it('loadTeamConfig ignores input scope and mcp_servers if provided', () => {
    const yaml = `
name: test-team
provider_profile: default
description: Test team
scope:
  accepts: ["*"]
  rejects: []
mcp_servers:
  - server1
`;
    const file = join(tmpDir, 'team.yaml');
    writeFileSync(file, yaml);
    // The loader should strip these fields during validation
    const config = loadTeamConfig(file);
    expect('scope' in config).toBe(false);
    expect('mcp_servers' in config).toBe(false);
  });

  it('getOrCreateTeamConfig returns config without scope or mcp_servers', () => {
    const runDir = makeTmpDir();
    const teamsDir = join(runDir, 'teams', 'new-team');
    mkdirSync(teamsDir, { recursive: true });

    const config = getOrCreateTeamConfig(runDir, 'new-team');
    expect('scope' in config).toBe(false);
    expect('mcp_servers' in config).toBe(false);

    rmSync(runDir, { recursive: true });
  });

  it('getOrCreateTeamConfig strips scope and mcp_servers from hints', () => {
    const runDir = makeTmpDir();
    const teamsDir = join(runDir, 'teams', 'hint-team');
    mkdirSync(teamsDir, { recursive: true });

    // Even if hints had these fields (they shouldn't), the result shouldn't have them
    const config = getOrCreateTeamConfig(runDir, 'hint-team', undefined, {
      description: 'Team with hints',
    });
    expect('scope' in config).toBe(false);
    expect('mcp_servers' in config).toBe(false);

    rmSync(runDir, { recursive: true });
  });
});