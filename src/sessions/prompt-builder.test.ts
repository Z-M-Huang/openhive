/**
 * Unit 6 + Unit 17: System Prompt Builder
 *
 * Tests that buildSystemPrompt assembles all sections correctly,
 * splits into staticPrefix/dynamicSuffix, and omits optional sections
 * when their inputs are empty.
 */

import { describe, it, expect } from 'vitest';

import {
  buildSystemPrompt,
  buildToolAvailabilityNote,
  type PromptBuilderOpts,
} from './prompt-builder.js';
import type { RuleCascadeResult } from '../rules/cascade.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOpts(overrides?: Partial<PromptBuilderOpts>): PromptBuilderOpts {
  return {
    teamName: 'test-team',
    cwd: '/data/teams/test-team',
    allowedTools: ['*'],
    credentialKeys: [],
    ruleCascade: { staticRules: '', dynamicRules: '' },
    skillsContent: '',
    memorySection: '',
    ...overrides,
  };
}

/** Concatenate both parts (for backward-compat content assertions). */
function fullPrompt(opts: PromptBuilderOpts): string {
  const parts = buildSystemPrompt(opts);
  return [parts.staticPrefix, parts.dynamicSuffix].filter(Boolean).join('\n\n');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Unit 6: System Prompt Builder', () => {
  it('includes core instructions in dynamicSuffix', () => {
    const result = buildSystemPrompt(makeOpts());
    expect(result.dynamicSuffix).toContain('You are an AI agent team member in the OpenHive system');
  });

  it('includes tool availability when allowed_tools=["*"]', () => {
    const result = buildSystemPrompt(makeOpts({ allowedTools: ['*'] }));
    expect(result.dynamicSuffix).toContain('--- Tool Availability for This Team ---');
    expect(result.dynamicSuffix).toContain('All tools are ENABLED for this team');
  });

  it('includes per-tool ENABLED/DISABLED when allowed_tools is selective', () => {
    const result = buildSystemPrompt(makeOpts({ allowedTools: ['Read', 'Write'] }));
    expect(result.dynamicSuffix).toContain('- **Read** — ENABLED');
    expect(result.dynamicSuffix).toContain('- **Write** — ENABLED');
    expect(result.dynamicSuffix).toContain('- **Bash** — DISABLED');
    expect(result.dynamicSuffix).toContain('- **Grep** — DISABLED');
  });

  it('includes credential note when keys present', () => {
    const result = buildSystemPrompt(makeOpts({ credentialKeys: ['GITHUB_TOKEN', 'SLACK_KEY'] }));
    expect(result.dynamicSuffix).toContain('## Available Credentials');
    expect(result.dynamicSuffix).toContain('`GITHUB_TOKEN`');
    expect(result.dynamicSuffix).toContain('`SLACK_KEY`');
    expect(result.dynamicSuffix).toContain('get_credential({ key: "KEY_NAME" })');
  });

  it('omits credential note when no keys', () => {
    const prompt = fullPrompt(makeOpts({ credentialKeys: [] }));
    expect(prompt).not.toContain('## Available Credentials');
  });

  it('includes static rule cascade in staticPrefix', () => {
    const cascade: RuleCascadeResult = {
      staticRules: '--- System Rules ---\n# Safety\nGlobal safety',
      dynamicRules: '',
    };
    const result = buildSystemPrompt(makeOpts({ ruleCascade: cascade }));
    expect(result.staticPrefix).toContain('--- System Rules ---');
    expect(result.staticPrefix).toContain('Global safety');
  });

  it('includes dynamic rule cascade in dynamicSuffix', () => {
    const cascade: RuleCascadeResult = {
      staticRules: '',
      dynamicRules: '--- Team Rules: test-team ---\nTeam rule content',
    };
    const result = buildSystemPrompt(makeOpts({ ruleCascade: cascade }));
    expect(result.dynamicSuffix).toContain('--- Team Rules: test-team ---');
    expect(result.dynamicSuffix).toContain('Team rule content');
  });

  it('includes skills content in dynamicSuffix', () => {
    const skills = '## Skills\n- deploy: Deploy the application\n- rollback: Rollback deployment';
    const result = buildSystemPrompt(makeOpts({ skillsContent: skills }));
    expect(result.dynamicSuffix).toContain('## Skills');
    expect(result.dynamicSuffix).toContain('deploy: Deploy the application');
  });

  it('includes memory section in dynamicSuffix', () => {
    const memory = '## Memory\n- Last deployment: 2026-03-28 at 14:00 UTC';
    const result = buildSystemPrompt(makeOpts({ memorySection: memory }));
    expect(result.dynamicSuffix).toContain('## Memory');
    expect(result.dynamicSuffix).toContain('Last deployment: 2026-03-28');
  });

  it('includes HTTP rules in staticPrefix', () => {
    const result = buildSystemPrompt(makeOpts());
    expect(result.staticPrefix).toContain('## HTTP Request Rules');
    expect(result.staticPrefix).toContain('--connect-timeout 10 --max-time 60');
    expect(result.staticPrefix).toContain('2 attempts max for auth failures');
  });

  it('includes tool usage guide in staticPrefix', () => {
    const result = buildSystemPrompt(makeOpts());
    expect(result.staticPrefix).toContain('## Available Built-in Tools');
    expect(result.staticPrefix).toContain('**Read** — Read a file');
    expect(result.staticPrefix).toContain('**Bash** — Execute a shell command');
    expect(result.staticPrefix).toContain('**Glob** — Find files matching a pattern');
  });
});

describe('Unit 17: Static/Dynamic split properties', () => {
  it('returns an object with staticPrefix and dynamicSuffix', () => {
    const result = buildSystemPrompt(makeOpts());
    expect(result).toHaveProperty('staticPrefix');
    expect(result).toHaveProperty('dynamicSuffix');
    expect(typeof result.staticPrefix).toBe('string');
    expect(typeof result.dynamicSuffix).toBe('string');
  });

  it('staticPrefix is byte-identical across teams with different cwd', () => {
    const cascade: RuleCascadeResult = {
      staticRules: '--- System Rules ---\n# Safety\nBe safe',
      dynamicRules: '--- Team Rules: team-a ---\nTeam A rules',
    };
    const resultA = buildSystemPrompt(makeOpts({
      teamName: 'team-a', cwd: '/data/teams/team-a',
      ruleCascade: cascade,
    }));
    const resultB = buildSystemPrompt(makeOpts({
      teamName: 'team-b', cwd: '/data/teams/team-b',
      ruleCascade: { ...cascade, dynamicRules: '--- Team Rules: team-b ---\nTeam B rules' },
    }));
    expect(resultA.staticPrefix).toBe(resultB.staticPrefix);
  });

  it('staticPrefix does NOT contain credentials', () => {
    const result = buildSystemPrompt(makeOpts({
      credentialKeys: ['SECRET_KEY', 'API_TOKEN'],
    }));
    expect(result.staticPrefix).not.toContain('SECRET_KEY');
    expect(result.staticPrefix).not.toContain('API_TOKEN');
    expect(result.staticPrefix).not.toContain('## Available Credentials');
  });

  it('staticPrefix does NOT contain cwd', () => {
    const result = buildSystemPrompt(makeOpts({ cwd: '/data/teams/test-team' }));
    expect(result.staticPrefix).not.toContain('/data/teams/test-team');
  });

  it('dynamicSuffix contains cwd-specific content', () => {
    const result = buildSystemPrompt(makeOpts({ cwd: '/data/teams/test-team' }));
    expect(result.dynamicSuffix).toContain('/data/teams/test-team');
  });

  it('staticPrefix does NOT contain team-specific rules', () => {
    const cascade: RuleCascadeResult = {
      staticRules: '--- System Rules ---\nGlobal',
      dynamicRules: '--- Team Rules: test-team ---\nTeam specific',
    };
    const result = buildSystemPrompt(makeOpts({ ruleCascade: cascade }));
    expect(result.staticPrefix).not.toContain('Team specific');
    expect(result.dynamicSuffix).toContain('Team specific');
  });
});

describe('buildToolAvailabilityNote', () => {
  it('wildcard glob patterns match tool prefixes', () => {
    // A pattern like "Re*" should match "Read"
    const note = buildToolAvailabilityNote(['Re*', 'Bash']);
    expect(note).toContain('- **Read** — ENABLED');
    expect(note).toContain('- **Bash** — ENABLED');
    expect(note).toContain('- **Write** — DISABLED');
  });
});
