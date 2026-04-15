/**
 * UT-7m: Message Handler
 *
 * Migrated from query-options.test.ts (Unit 8).
 * Tests: handleMessage error paths + config loading.
 *
 * Note: Tests that require a running model (maxSteps passthrough,
 * credential scrubbing, sourceChannelId) are covered by the individual
 * component tests: provider-resolver.test.ts, context-builder.test.ts,
 * memory-loader.test.ts, skill-loader.test.ts, and prompt-builder.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { stringify as yamlStringify } from 'yaml';

import { handleMessage } from './message-handler.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { ProvidersOutput } from '../config/validation.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Test-only placeholder. Not a real key. */
const TEST_KEY_VALUE = 'test-placeholder-key-not-real';

function makeProviders(overrides?: Partial<ProvidersOutput>): ProvidersOutput {
  return {
    profiles: {
      default: {
        type: 'api',
        api_key: TEST_KEY_VALUE,
        model: 'claude-sonnet-4-20250514',
      },
    },
    ...overrides,
  };
}

function makeDeps(runDir: string, overrides?: Partial<MessageHandlerDeps>): MessageHandlerDeps {
  return {
    providers: makeProviders(),
    runDir,
    dataDir: runDir,
    systemRulesDir: join(runDir, 'system-rules'),
    orgAncestors: [],
    logger: { info: () => {} },
    ...overrides,
  };
}

// ── UT-7m: Message Handler ─────────────────────────────────────────────────

describe('UT-7m: Message Handler', () => {
  it('returns error when team config not found', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-mh-'));
    const deps = makeDeps(runDir);

    const result = await handleMessage(
      { content: 'hello', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'nonexistent' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('returns error when config.yaml is invalid', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-mh-'));
    const teamDir = join(runDir, 'teams', 'bad-team');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'config.yaml'), 'not: valid: yaml: [');

    const deps = makeDeps(runDir);

    const result = await handleMessage(
      { content: 'hello', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'bad-team' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('returns error when provider profile not found', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-mh-'));
    const teamDir = join(runDir, 'teams', 'missing-profile');
    mkdirSync(teamDir, { recursive: true });

    const config = {
      name: 'missing-profile',
      description: 'Test',
      allowed_tools: ['Read'],
      mcp_servers: [],
      provider_profile: 'nonexistent-profile',
      maxSteps: 25,
    };
    writeFileSync(join(teamDir, 'config.yaml'), yamlStringify(config));

    const deps = makeDeps(runDir);

    const result = await handleMessage(
      { content: 'hello', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'missing-profile' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('includes durationMs in all responses', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-mh-'));
    const deps = makeDeps(runDir);

    const result = await handleMessage(
      { content: 'hello', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'nonexistent' },
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('session failure is caught as error (not crash)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-mh-'));
    const teamDir = join(runDir, 'teams', 'mcp-team');
    mkdirSync(teamDir, { recursive: true });

    const config = {
      name: 'mcp-team',
      description: 'Test',
      allowed_tools: ['Read'],
      provider_profile: 'default',
      maxSteps: 25,
    };
    writeFileSync(join(teamDir, 'config.yaml'), yamlStringify(config));

    const deps = makeDeps(runDir);

    // Should not throw — error is caught and returned as ok: false
    const result = await handleMessage(
      { content: 'hello', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'mcp-team' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── AC-14: effectiveSkill demotion block removal ───────────────────────────

describe('message-handler ADR-40 effectiveSkill removal', () => {
  it('file does not contain effectiveSkill demotion block', () => {
    const src = readFileSync('src/sessions/message-handler.ts', 'utf8');
    expect(src).not.toMatch(/effectiveSkill/);
    expect(src).not.toMatch(/opts\?\.subagent\s*\?\s*undefined\s*:\s*opts\?\.skill/);
  });
});
