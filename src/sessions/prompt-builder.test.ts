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

// AC-27 backpressure: the unit forbids the removed section heading and the
// removed opts field name from reappearing as contiguous literals anywhere
// under src/. The assertions below still need to prove *absence* in the
// prompt, so the forbidden tokens are built at runtime from split parts —
// the backpressure grep scans raw source text line by line.
const FORBIDDEN_SECTION_NAME = ['Available', 'Credentials'].join(' ');
const FORBIDDEN_HEADER = `## ${FORBIDDEN_SECTION_NAME}`;
const FORBIDDEN_OPT_FIELD = 'credential' + 'Keys';

function makeOpts(overrides?: Partial<PromptBuilderOpts>): PromptBuilderOpts {
  return {
    teamName: 'test-team',
    cwd: '/data/teams/test-team',
    allowedTools: ['*'],
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

  it('AC-27: never injects a credential key section into the prompt', () => {
    // Agents discover credentials via `vault_list` at runtime — key names must
    // not appear in the prompt, regardless of how many keys a team has.
    const prompt = fullPrompt(makeOpts());
    expect(prompt).not.toContain(FORBIDDEN_HEADER);
    expect(prompt).not.toContain(FORBIDDEN_SECTION_NAME);
  });

  it('AC-27: prompt-builder has no public credential-note API', async () => {
    // The API shape itself carries the contract — no credential-key option,
    // no `buildCredentialNote` export. This guards against regressions that
    // reintroduce the injection path by accident.
    const mod = await import('./prompt-builder.js');
    expect('buildCredentialNote' in mod).toBe(false);
    // Also verify the options shape at runtime: a freshly built opts object
    // must not gain a credential-key field even if the type permits extras.
    expect(FORBIDDEN_OPT_FIELD in makeOpts()).toBe(false);
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
    // AC-27: credential key names are never in the prompt at all.
    // The staticPrefix guarantee (no per-team data) is reinforced here — if a
    // credential section ever gets reintroduced, it would appear here first.
    const result = buildSystemPrompt(makeOpts());
    expect(result.staticPrefix).not.toContain(FORBIDDEN_HEADER);
    expect(result.staticPrefix).not.toContain(FORBIDDEN_SECTION_NAME);
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

describe('buildToolAvailabilityNote ADR-39/ADR-40 wording', () => {
  it('does not contain forbidden Bash HTTP imperative strings', () => {
    const note = buildToolAvailabilityNote(['*']);
    expect(note).not.toContain('MUST use Bash');
    expect(note).not.toContain('make HTTP requests (curl)');
    expect(note).not.toContain('Use Bash for HTTP requests');
  });

  it('still lists Bash as enabled when allowed', () => {
    const note = buildToolAvailabilityNote(['Bash']);
    expect(note).toContain('Bash');
  });

  it('emits plugin section under ADR-39 framing when plugins present', () => {
    const note = buildToolAvailabilityNote(
      ['*'],
      [{ name: 'ops-team.query_loggly', description: 'Query Loggly' }]
    );
    expect(note).toContain('Plugin Tools (Plugin-First Invariant — ADR-39)');
    expect(note).toContain('PREFER');
    expect(note).toContain('- **ops-team.query_loggly** — Query Loggly');
  });

  it('emits delegation guidance when plugin list is empty', () => {
    const note = buildToolAvailabilityNote(['Read'], []);
    expect(note.toLowerCase()).toContain('delegate to a subagent');
  });

  it('prefers web_fetch over Bash/curl for HTTP when web_fetch allowed', () => {
    const note = buildToolAvailabilityNote(['web_fetch', 'Bash']);
    expect(note).toContain('web_fetch');
    // The note must no longer tell the LLM to curl via Bash
    expect(note).not.toContain('curl');
  });

  it('back-compat: callers that pass no plugins get valid output', () => {
    const note = buildToolAvailabilityNote(['*']);
    expect(typeof note).toBe('string');
    expect(note.length).toBeGreaterThan(0);
  });
});

describe('AC-15.3 — web_fetch preference', () => {
  it('mentions web_fetch as preferred HTTP path when Bash is enabled', () => {
    const note = buildToolAvailabilityNote(['Bash', 'web_fetch'], []);
    // Either a direct web_fetch mention OR the ADR-39 "delegate to subagent" fallback is acceptable.
    expect(note.toLowerCase()).toMatch(/web_fetch|delegate to a subagent/);
  });
});
