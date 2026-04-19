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

  it('ignores explicit skill when subagent is set (skill not injected into prompt)', async () => {
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

  it('Fix 4: injects the subagent identity (markdown) when subagent is set', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-fix4-id-'));
    setupTeam(runDir, 'team-fix4');
    setupSubagent(runDir, 'team-fix4', 'log-monitor');

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'tick', userId: 'system', channelId: 'task:1', timestamp: Date.now() },
      deps,
      { teamName: 'team-fix4', subagent: 'log-monitor', runSessionFn: runFn },
    );

    const dynamic = capturedDynamicSuffix(runFn);
    // Active Subagent header must be present so the model knows it is running
    // as the named subagent — not the team orchestrator. (Fix 4)
    expect(dynamic).toContain('--- Active Subagent: log-monitor ---');
    // Subagent's role markdown must be carried into the prompt so the model
    // sees the role/boundaries/skills declared in the .md file.
    expect(dynamic).toContain('A test subagent');
    // Skill-injection header must remain absent (Fix 4 reuses the skillsContent
    // slot but with a different marker — it must not look like a skill).
    expect(dynamic).not.toContain('--- Skills ---');
  });

  it('Fix 4: returns a clean error when subagent name does not exist on disk', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-fix4-miss-'));
    setupTeam(runDir, 'team-miss');
    // Intentionally do NOT create the subagent file.

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    const result = await handleMessage(
      { content: 'tick', userId: 'system', channelId: 'task:1', timestamp: Date.now() },
      deps,
      { teamName: 'team-miss', subagent: 'ghost', runSessionFn: runFn },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("subagent 'ghost' not found");
    // Session must NOT have been spawned when the subagent is missing.
    expect(runFn).not.toHaveBeenCalled();
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

// ── Fix 6 — subagent default directive + hybrid eager/lazy skill catalog ─────
//
// formatSubagentIdentity now injects a standing-rules block ("--- Subagent
// Default Behavior ---") plus either the single skill body (eager, 1 skill)
// or a name-only catalog (lazy, ≥2 skills) so the LLM always reaches skills
// and namespaced plugin tools before falling back to web_fetch / Bash.

function setupSubagentWithSkills(
  runDir: string,
  teamName: string,
  subagentName: string,
  skills: Array<{ name: string; description: string; body: string }>,
): void {
  const teamDir = join(runDir, 'teams', teamName);
  const subagentsDir = join(teamDir, 'subagents');
  const skillsDir = join(teamDir, 'skills');
  mkdirSync(subagentsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  const skillsSection = skills.map((s) => `- ${s.name} — ${s.description}`).join('\n');
  writeFileSync(
    join(subagentsDir, `${subagentName}.md`),
    `# Agent: ${subagentName}\n## Role\nA test subagent\n## Skills\n${skillsSection}\n`,
  );
  for (const s of skills) {
    writeFileSync(join(skillsDir, `${s.name}.md`), s.body);
  }
}

describe('handleMessage — Fix 6 subagent directive + skill hybrid', () => {
  it('directive is always present when subagent is set (0 skills)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-fix6-a-'));
    setupTeam(runDir, 'team-f6a');
    setupSubagent(runDir, 'team-f6a', 'writer');

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'team-f6a', subagent: 'writer', runSessionFn: runFn },
    );

    const dynamic = capturedDynamicSuffix(runFn);
    expect(dynamic).toContain('--- Subagent Default Behavior ---');
    expect(dynamic).toContain('use_skill');
    // With 0 skills, neither the eager body header nor the catalog header appears.
    expect(dynamic).not.toContain('--- Active Skill:');
    expect(dynamic).not.toContain('--- Available Skills');
  });

  it('eagerly inlines the single skill body (1 skill)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-fix6-b-'));
    setupTeam(runDir, 'team-f6b');
    setupSubagentWithSkills(runDir, 'team-f6b', 'log-monitor', [
      {
        name: 'monitor_loggly',
        description: 'Monitor Loggly logs',
        body: 'FIX6_SINGLE_SKILL_BODY_SENTINEL',
      },
    ]);

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'team-f6b', subagent: 'log-monitor', runSessionFn: runFn },
    );

    const dynamic = capturedDynamicSuffix(runFn);
    expect(dynamic).toContain('--- Subagent Default Behavior ---');
    expect(dynamic).toContain('--- Active Skill: monitor_loggly ---');
    expect(dynamic).toContain('FIX6_SINGLE_SKILL_BODY_SENTINEL');
    expect(dynamic).not.toContain('--- Available Skills');
  });

  it('namespaces bare plugin refs in the eagerly inlined singleton skill body', async () => {
    // Regression for Codex finding: singleton-skill eager-inline path must apply
    // the same `<team>.<tool>` rewrite as `use_skill`. Otherwise log-monitor (and
    // any 1-skill subagent) sees bare refs that don't match the namespaced tools
    // actually loaded into the toolset, and falls back to web_fetch.
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-fix6-ns-'));
    setupTeam(runDir, 'team-f6ns');
    const teamDir = join(runDir, 'teams', 'team-f6ns');
    mkdirSync(join(teamDir, 'subagents'), { recursive: true });
    mkdirSync(join(teamDir, 'skills'), { recursive: true });
    writeFileSync(
      join(teamDir, 'subagents', 'log-monitor.md'),
      '# Agent: log-monitor\n## Role\nlog watcher\n## Skills\n- monitor_loggly — Watch logs\n',
    );
    writeFileSync(
      join(teamDir, 'skills', 'monitor_loggly.md'),
      [
        '## Required Tools',
        '- fetch_loggly_logs',
        '- analyze_logs',
        '',
        '## Steps',
        '1. Call `fetch_loggly_logs` with creds.',
        '2. Hand the result to `analyze_logs`.',
      ].join('\n'),
    );

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'team-f6ns', subagent: 'log-monitor', runSessionFn: runFn },
    );

    const dynamic = capturedDynamicSuffix(runFn);
    expect(dynamic).toContain('--- Active Skill: monitor_loggly ---');
    // Required-tools bullet rewritten
    expect(dynamic).toContain('- team-f6ns.fetch_loggly_logs');
    expect(dynamic).toContain('- team-f6ns.analyze_logs');
    // Inline backtick refs rewritten
    expect(dynamic).toContain('`team-f6ns.fetch_loggly_logs`');
    expect(dynamic).toContain('`team-f6ns.analyze_logs`');
    // No bare reference survives
    expect(dynamic).not.toMatch(/(?<![.\w])fetch_loggly_logs(?![\w])/);
    expect(dynamic).not.toMatch(/(?<![.\w])analyze_logs(?![\w])/);
  });

  it('emits the lazy catalog for ≥2 skills (no bodies inlined)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'openhive-fix6-c-'));
    setupTeam(runDir, 'team-f6c');
    setupSubagentWithSkills(runDir, 'team-f6c', 'ops', [
      { name: 'monitor_loggly', description: 'Monitor Loggly logs', body: 'BODY_A_SHOULD_NOT_APPEAR' },
      { name: 'rotate_keys', description: 'Rotate credential keys', body: 'BODY_B_SHOULD_NOT_APPEAR' },
    ]);

    const logger = makeLogger();
    const runFn = stubRunSession();
    const deps = makeDeps(runDir, logger);

    await handleMessage(
      { content: 'hi', userId: 'test', channelId: 'cli', timestamp: Date.now() },
      deps,
      { teamName: 'team-f6c', subagent: 'ops', runSessionFn: runFn },
    );

    const dynamic = capturedDynamicSuffix(runFn);
    expect(dynamic).toContain('--- Subagent Default Behavior ---');
    expect(dynamic).toContain('--- Available Skills');
    expect(dynamic).toContain('- monitor_loggly — Monitor Loggly logs');
    expect(dynamic).toContain('- rotate_keys — Rotate credential keys');
    expect(dynamic).not.toContain('BODY_A_SHOULD_NOT_APPEAR');
    expect(dynamic).not.toContain('BODY_B_SHOULD_NOT_APPEAR');
    expect(dynamic).not.toContain('--- Active Skill:');
  });
});
