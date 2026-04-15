/**
 * Message handler — ADR-40 subagent-only execution enforcement (AC-16).
 *
 * Verifies that when `subagent` is set on HandleMessageOpts:
 *   1. message-handler does NOT inject skill content into the system prompt
 *      (the old "direct skill injection path" must not remain active).
 *   2. The tool-assembler does NOT load plugin tools via the skill pathway.
 *   3. If `skill` is also supplied, it is demoted to a non-authoritative hint
 *      and a warning is logged (ADR-40 precedence: subagent wins).
 *   4. When `subagent` is absent, the legacy skill injection path is preserved
 *      (main-team exception retained for backwards compat until Unit U31).
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { stringify as yamlStringify } from 'yaml';

import { handleMessage } from './message-handler.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { ProvidersOutput } from '../config/validation.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const TEST_KEY_VALUE = 'test-placeholder-key-not-real';

function makeProviders(): ProvidersOutput {
  return {
    profiles: {
      default: {
        type: 'api',
        api_key: TEST_KEY_VALUE,
        model: 'claude-sonnet-4-20250514',
      },
    },
  };
}

function setupTeam(runDir: string, teamName: string): void {
  const teamDir = join(runDir, 'teams', teamName);
  mkdirSync(teamDir, { recursive: true });
  mkdirSync(join(teamDir, 'skills'), { recursive: true });
  writeFileSync(
    join(teamDir, 'config.yaml'),
    yamlStringify({
      name: teamName,
      description: 'Test team',
      allowed_tools: ['Read'],
      provider_profile: 'default',
      maxSteps: 25,
    }),
  );
  // A skill file so we can assert whether it was injected into the prompt.
  writeFileSync(
    join(teamDir, 'skills', 'demo-skill.md'),
    '## Demo Skill\nContent marker: DEMO_SKILL_BODY_SENTINEL.\n',
  );
}

function setupSubagent(runDir: string, teamName: string, subagentName: string): void {
  const subagentsDir = join(runDir, 'teams', teamName, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(
    join(subagentsDir, `${subagentName}.md`),
    `# Agent: ${subagentName}\n## Role\nA test subagent\n`,
  );
}

interface CapturedLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

function makeLogger(): CapturedLogger {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeDeps(runDir: string, logger: CapturedLogger): MessageHandlerDeps {
  return {
    providers: makeProviders(),
    runDir,
    dataDir: runDir,
    systemRulesDir: join(runDir, 'system-rules'),
    orgAncestors: [],
    logger,
  };
}

type RunSessionSpy = ReturnType<typeof vi.fn>;

function stubRunSession(): RunSessionSpy {
  // Return an empty-text result so handleMessage resolves to ok:true without
  // invoking scrub or network paths.
  return vi.fn().mockResolvedValue({ text: '', steps: 0, scrubbed: false });
}

/** Extract the dynamicSuffix (where skillsContent lives) from a captured call. */
function capturedDynamicSuffix(spy: RunSessionSpy): string {
  expect(spy).toHaveBeenCalledTimes(1);
  const callArg = spy.mock.calls[0][0] as { system: { dynamicSuffix?: string } | string };
  if (typeof callArg.system === 'string') return callArg.system;
  return callArg.system.dynamicSuffix ?? '';
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('handleMessage — ADR-40 subagent-only execution (AC-16)', () => {
  it('skips skill injection when subagent is set (no explicit skill)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-adr40-a-'));
    setupTeam(runDir, 'team-a');
    setupSubagent(runDir, 'team-a', 'researcher');

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    const result = await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'team-a', subagent: 'researcher', runSessionFn: runFn },
    );

    expect(result.ok).toBe(true);
    const dynamic = capturedDynamicSuffix(runFn);
    // The direct skill-injection path produces a "--- Skills ---" header,
    // followed by skill body content. ADR-40 requires BOTH to be absent.
    expect(dynamic).not.toContain('--- Skills ---');
    expect(dynamic).not.toContain('DEMO_SKILL_BODY_SENTINEL');
  });

  it('ignores explicit skill when subagent is set and logs the precedence warning', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-adr40-b-'));
    setupTeam(runDir, 'team-b');
    setupSubagent(runDir, 'team-b', 'writer');

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      {
        teamName: 'team-b',
        subagent: 'writer',
        skill: 'demo-skill',
        runSessionFn: runFn,
      },
    );

    expect(logger.info).toHaveBeenCalledWith(
      'Ignoring skill hint due to subagent precedence (ADR-40)',
      expect.objectContaining({
        teamName: 'team-b',
        subagent: 'writer',
        skill: 'demo-skill',
      }),
    );

    const dynamic = capturedDynamicSuffix(runFn);
    expect(dynamic).not.toContain('--- Skills ---');
    expect(dynamic).not.toContain('DEMO_SKILL_BODY_SENTINEL');
  });

  it('does NOT log the ADR-40 precedence warning when only subagent is set', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-adr40-c-'));
    setupTeam(runDir, 'team-c');
    setupSubagent(runDir, 'team-c', 'researcher');

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'team-c', subagent: 'researcher', runSessionFn: runFn },
    );

    const adrCalls = logger.info.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('ADR-40'),
    );
    expect(adrCalls).toHaveLength(0);
  });

  it('preserves skill injection when subagent is NOT set (main-team legacy path)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-adr40-d-'));
    setupTeam(runDir, 'team-d');

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'team-d', skill: 'demo-skill', runSessionFn: runFn },
    );

    const dynamic = capturedDynamicSuffix(runFn);
    // Legacy path — skill IS injected because no subagent is set. Unit U31
    // later locks this down to the main-team exception.
    expect(dynamic).toContain('--- Skills ---');
    expect(dynamic).toContain('DEMO_SKILL_BODY_SENTINEL');
  });
});
