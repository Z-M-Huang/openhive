/**
 * Skill and Subagent Loader
 *
 * Tests: loadSkillsContent and loadSubagents for empty/populated directories
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import {
  loadSkillsContent,
  loadSubagents,
  resolveActiveSkill,
  loadActiveSkillContent,
} from './skill-loader.js';

// ── Skill and Subagent Loader ────────────────────────────────────────────

describe('Skill and Subagent Loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l6-skills-'));
    mkdirSync(join(dir, 'teams', 'test-team', 'skills'), { recursive: true });
    mkdirSync(join(dir, 'teams', 'test-team', 'subagents'), { recursive: true });
  });

  it('returns empty string when skills/ is empty', () => {
    expect(loadSkillsContent(dir, 'test-team')).toBe('');
  });

  it('returns concatenated content with header when skills/ has .md files', () => {
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'deploy.md'), '# Deploy\nStep 1');
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'review.md'), '# Review\nStep A');
    const result = loadSkillsContent(dir, 'test-team');
    expect(result).toContain('--- Skills ---');
    expect(result).toContain('# Deploy');
    expect(result).toContain('# Review');
  });

  it('returns empty record when subagents/ is empty', () => {
    expect(Object.keys(loadSubagents(dir, 'test-team'))).toHaveLength(0);
  });

  // ── resolveActiveSkill system fallback ───────────────────────────────────

  it('resolveActiveSkill returns null when no skillName', () => {
    expect(resolveActiveSkill(dir, 'test-team')).toBeNull();
  });

  it('resolveActiveSkill resolves from team path first', () => {
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'deploy.md'), '# Team Deploy');
    const result = resolveActiveSkill(dir, 'test-team', 'deploy');
    expect(result).toEqual({ name: 'deploy', content: '# Team Deploy' });
  });

  it('resolveActiveSkill falls back to systemRulesDir when team skill missing', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'openhive-sysrules-'));
    mkdirSync(join(sysDir, 'skills'), { recursive: true });
    writeFileSync(join(sysDir, 'skills', 'learning-cycle.md'), '# System Learning');
    const result = resolveActiveSkill(dir, 'test-team', 'learning-cycle', sysDir);
    expect(result).toEqual({ name: 'learning-cycle', content: '# System Learning' });
  });

  it('resolveActiveSkill team skill overrides system skill', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'openhive-sysrules-'));
    mkdirSync(join(sysDir, 'skills'), { recursive: true });
    writeFileSync(join(sysDir, 'skills', 'deploy.md'), '# System Deploy');
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'deploy.md'), '# Team Deploy');
    const result = resolveActiveSkill(dir, 'test-team', 'deploy', sysDir);
    expect(result).toEqual({ name: 'deploy', content: '# Team Deploy' });
  });

  it('resolveActiveSkill returns null when skill not found anywhere', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'openhive-sysrules-'));
    mkdirSync(join(sysDir, 'skills'), { recursive: true });
    const result = resolveActiveSkill(dir, 'test-team', 'nonexistent', sysDir);
    expect(result).toBeNull();
  });

  // ── loadActiveSkillContent active-only semantics (AC-20) ─────────────────

  it('loadActiveSkillContent returns empty string when no active skill', () => {
    // Even if skills exist on disk, no active skill means no injection.
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'deploy.md'), '# Deploy');
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'review.md'), '# Review');
    expect(loadActiveSkillContent(null)).toBe('');
  });

  it('loadActiveSkillContent injects only the active skill with header', () => {
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'deploy.md'), '# Deploy\nbody-deploy');
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'review.md'), '# Review\nbody-review');

    const active = resolveActiveSkill(dir, 'test-team', 'deploy');
    const result = loadActiveSkillContent(active);

    expect(result).toContain('--- Skills ---');
    expect(result).toContain('# Deploy');
    expect(result).toContain('body-deploy');
    // Critical: inactive skill body must NOT leak into the active-skill output
    expect(result).not.toContain('body-review');
    expect(result).not.toContain('# Review');
  });

  it('loadActiveSkillContent returns empty string when requested skill is missing', () => {
    // Simulate resolveActiveSkill returning null because the file is missing
    const active = resolveActiveSkill(dir, 'test-team', 'nonexistent');
    expect(active).toBeNull();
    expect(loadActiveSkillContent(active)).toBe('');
  });

  // ── Subagent parsing ─────────────────────────────────────────────────────

  it('parses subagent .md format', () => {
    const content = '# Agent: Devops\n## Role\nHandles deployments\n## Skills\n- deploy — run deploys\n- rollback — undo deploys\n';
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'devops.md'), content);
    const agents = loadSubagents(dir, 'test-team');
    const keys = Object.keys(agents);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('Devops');
    const agent = agents['Devops'];
    expect(agent.description).toBe('Handles deployments');
    expect(agent.skills).toEqual(['deploy', 'rollback']);
  });

  // ── Subagent Boundaries parsing (AC-21) ──────────────────────────────────

  it('parses single-paragraph `## Boundaries` into boundaries field', () => {
    const content = [
      '# Agent: Writer',
      '## Role',
      'Drafts copy',
      '## Boundaries',
      'Never publish without review. Always cite sources.',
      '## Skills',
      '- draft — produce first draft',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'writer.md'), content);

    const agents = loadSubagents(dir, 'test-team');
    const agent = agents['Writer'];
    expect(agent).toBeDefined();
    expect(agent.boundaries).toBe('Never publish without review. Always cite sources.');
  });

  it('preserves multi-paragraph `## Boundaries` until next `##` heading', () => {
    const content = [
      '# Agent: Researcher',
      '## Role',
      'Investigates topics',
      '## Boundaries',
      'Never call external APIs without approval.',
      '',
      'Always record sources in the memory store.',
      '',
      '- no personal data in queries',
      '- no paid APIs',
      '## Skills',
      '- research — investigate a topic',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'researcher.md'), content);

    const agent = loadSubagents(dir, 'test-team')['Researcher'];
    expect(agent).toBeDefined();
    const boundaries = agent.boundaries ?? '';
    // Multi-paragraph preservation — both paragraphs and the bullet list must survive
    expect(boundaries).toContain('Never call external APIs without approval.');
    expect(boundaries).toContain('Always record sources in the memory store.');
    expect(boundaries).toContain('- no personal data in queries');
    expect(boundaries).toContain('- no paid APIs');
    // Must NOT leak content from the following `## Skills` section
    expect(boundaries).not.toContain('research — investigate a topic');
    expect(boundaries).not.toContain('## Skills');
  });

  it('omits boundaries field when subagent markdown has no `## Boundaries` section', () => {
    const content = '# Agent: Minimal\n## Role\nA minimal agent\n## Skills\n- noop — do nothing\n';
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'minimal.md'), content);

    const agent = loadSubagents(dir, 'test-team')['Minimal'];
    expect(agent).toBeDefined();
    expect(agent.boundaries).toBeUndefined();
  });

  // ── Subagent Communication Style parsing (AC-22) ─────────────────────────

  it('parses `## Communication Style` into communicationStyle field', () => {
    const content = [
      '# Agent: Concierge',
      '## Role',
      'Greets users',
      '## Communication Style',
      'Warm, friendly, concise. Use bullet points for lists.',
      '## Skills',
      '- greet — greet a user',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'concierge.md'), content);

    const agent = loadSubagents(dir, 'test-team')['Concierge'];
    expect(agent).toBeDefined();
    expect(agent.communicationStyle).toBe('Warm, friendly, concise. Use bullet points for lists.');
  });

  it('preserves multi-paragraph `## Communication Style` until next `##` heading', () => {
    const content = [
      '# Agent: Analyst',
      '## Role',
      'Reports findings',
      '## Communication Style',
      'Formal tone. Always include a TL;DR at the top.',
      '',
      'Quote sources verbatim. Never paraphrase numbers.',
      '## Boundaries',
      'Never disclose competitor data.',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'analyst.md'), content);

    const agent = loadSubagents(dir, 'test-team')['Analyst'];
    expect(agent).toBeDefined();
    const style = agent.communicationStyle ?? '';
    expect(style).toContain('Formal tone. Always include a TL;DR at the top.');
    expect(style).toContain('Quote sources verbatim. Never paraphrase numbers.');
    // Must NOT bleed into the following `## Boundaries` section
    expect(style).not.toContain('Never disclose competitor data.');
    expect(style).not.toContain('## Boundaries');
  });

  it('omits communicationStyle field when section is absent (backward compat)', () => {
    const content = '# Agent: Legacy\n## Role\nNo new sections\n## Skills\n- noop — do nothing\n';
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'legacy.md'), content);
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'noop.md'), '# noop\nDo nothing.\n');

    const warn = vi.fn();
    const agent = loadSubagents(dir, 'test-team', warn)['Legacy'];
    expect(agent).toBeDefined();
    expect(agent.communicationStyle).toBeUndefined();
    // Missing section is NOT malformed — no warning should fire.
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits a warning with filename when `## Communication Style` is present but empty (malformed)', () => {
    // Header present, body empty, then next section starts immediately.
    const content = [
      '# Agent: Bad',
      '## Role',
      'Has malformed comm style',
      '## Communication Style',
      '## Skills',
      '- noop — do nothing',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'bad.md'), content);
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'noop.md'), '# noop\nDo nothing.\n');

    const warn = vi.fn();
    const agents = loadSubagents(dir, 'test-team', warn);

    // Loader does NOT throw — definition is still returned, just without the field
    expect(agents['Bad']).toBeDefined();
    expect(agents['Bad'].communicationStyle).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const warnMsg = warn.mock.calls[0][0] as string;
    expect(warnMsg).toContain('bad.md');
    expect(warnMsg).toContain('Communication Style');
  });

  it('does not require the warn callback to be passed', () => {
    // Calling without warn must not throw — backward compat with existing 2-arg callers.
    const content = '# Agent: NoWarn\n## Role\nUnused\n';
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'no-warn.md'), content);
    expect(() => loadSubagents(dir, 'test-team')).not.toThrow();
  });
});

// ── loadSubagents resolvedSkills (AC-10) ──────────────────────────────────

/**
 * Create a temporary team directory with the given fixtures.
 * Returns the temp directory root that can be passed as runDir to loaders.
 */
async function mkTempTeamDir(fixtures: {
  subagents?: Record<string, string>;
  skills?: Record<string, string>;
}): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'openhive-mktemp-'));
  const subagentsDir = join(tmpDir, 'teams', 'ops', 'subagents');
  const skillsDir = join(tmpDir, 'teams', 'ops', 'skills');
  mkdirSync(subagentsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  if (fixtures.subagents) {
    for (const [name, content] of Object.entries(fixtures.subagents)) {
      writeFileSync(join(subagentsDir, name), content);
    }
  }
  if (fixtures.skills) {
    for (const [name, content] of Object.entries(fixtures.skills)) {
      writeFileSync(join(skillsDir, name), content);
    }
  }
  return tmpDir;
}

describe('loadSubagents resolvedSkills', () => {
  it('populates resolvedSkills from referenced skill files', async () => {
    const tmpDir = await mkTempTeamDir({
      subagents: {
        'loggly-monitor.md': '# Agent: loggly-monitor\n## Skills\n- alert-check\n',
      },
      skills: {
        'alert-check.md': '# alert-check\n## Required Tools\n- query_loggly\n',
      },
    });

    const defs = loadSubagents(tmpDir, 'ops');
    expect(defs['loggly-monitor'].resolvedSkills).toEqual([
      {
        name: 'alert-check',
        content: expect.stringContaining('alert-check') as unknown,
        requiredTools: ['query_loggly'],
      },
    ]);
  });

  it('warns and continues when a referenced skill file is missing', async () => {
    const warn = vi.fn();
    const tmpDir = await mkTempTeamDir({
      subagents: {
        'a.md': '# Agent: a\n## Skills\n- missing-skill\n',
      },
      skills: {},
    });

    const defs = loadSubagents(tmpDir, 'ops', warn);
    expect(defs['a']).toBeDefined();
    expect(defs['a'].resolvedSkills).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/missing-skill/),
    );
  });

  it('empty ## Skills produces empty resolvedSkills array', async () => {
    const tmpDir = await mkTempTeamDir({
      subagents: { 'a.md': '# Agent: a\n(no skills section)\n' },
      skills: {},
    });
    const defs = loadSubagents(tmpDir, 'ops');
    expect(defs['a'].resolvedSkills).toEqual([]);
  });
});
