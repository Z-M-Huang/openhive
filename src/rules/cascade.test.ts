/**
 * Rule cascade + conflict detection tests (migrated from layer-3.test.ts)
 *
 * - Rule cascade: concatenates global -> main org -> ancestor org -> team org -> team-rules
 * - [OVERRIDE] rules replace parent rules without conflict warning
 * - Conflicts detected for same-topic at different levels without [OVERRIDE]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { buildRuleCascade } from './cascade.js';
import { validateRuleCascade } from './validator.js';
import type { AnnotatedRule } from './validator.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-l3-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Rule Cascade ──────────────────────────────────────────────────────────

describe('Rule Cascade', () => {
  let systemRulesDir: string;
  let dataDir: string;
  let runDir: string;

  beforeEach(() => {
    systemRulesDir = makeTmpDir();
    dataDir = makeTmpDir();
    runDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(systemRulesDir)) rmSync(systemRulesDir, { recursive: true });
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true });
    if (existsSync(runDir)) rmSync(runDir, { recursive: true });
  });

  it('concatenates all levels in correct order', () => {
    // System rules (Tier 1)
    writeFileSync(join(systemRulesDir, '01-safety.md'), '# Safety\nGlobal safety');

    // Admin org rules (Tier 2): {dataDir}/rules/
    const adminOrgDir = join(dataDir, 'rules');
    mkdirSync(adminOrgDir, { recursive: true });
    writeFileSync(join(adminOrgDir, '01-org.md'), '# Org\nMain org rule');

    // Ancestor org-rules (grandparent -> parent): {runDir}/teams/{ancestor}/org-rules/
    const gpDir = join(runDir, 'teams', 'grandparent', 'org-rules');
    mkdirSync(gpDir, { recursive: true });
    writeFileSync(join(gpDir, '01-gp.md'), '# GP\nGrandparent rule');

    const parentDir = join(runDir, 'teams', 'parent', 'org-rules');
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, '01-parent.md'), '# Parent\nParent rule');

    // Team's own org-rules: {runDir}/teams/{teamName}/org-rules/
    const teamOrgDir = join(runDir, 'teams', 'my-team', 'org-rules');
    mkdirSync(teamOrgDir, { recursive: true });
    writeFileSync(join(teamOrgDir, '01-team-org.md'), '# Team Org\nTeam org rule');

    // Team-only rules: {runDir}/teams/{teamName}/team-rules/
    const teamRulesDir = join(runDir, 'teams', 'my-team', 'team-rules');
    mkdirSync(teamRulesDir, { recursive: true });
    writeFileSync(join(teamRulesDir, '01-local.md'), '# Local\nTeam-only rule');

    const result = buildRuleCascade({
      teamName: 'my-team',
      ancestors: ['grandparent', 'parent'],
      runDir,
      dataDir,
      systemRulesDir,
    });

    // Static rules (Tier 1 + 2)
    expect(result.staticRules).toContain('--- System Rules ---');
    expect(result.staticRules).toContain('Global safety');
    expect(result.staticRules).toContain('--- Organization Rules ---');
    expect(result.staticRules).toContain('Main org rule');

    // Verify static order
    const systemIdx = result.staticRules.indexOf('--- System Rules ---');
    const orgIdx = result.staticRules.indexOf('--- Organization Rules ---');
    expect(systemIdx).toBeGreaterThanOrEqual(0);
    expect(orgIdx).toBeGreaterThan(systemIdx);

    // Dynamic rules (Tier 3 + 4)
    expect(result.dynamicRules).toContain('--- Org Rules: grandparent ---');
    expect(result.dynamicRules).toContain('Grandparent rule');
    expect(result.dynamicRules).toContain('--- Org Rules: parent ---');
    expect(result.dynamicRules).toContain('Parent rule');
    expect(result.dynamicRules).toContain('--- Org Rules: my-team ---');
    expect(result.dynamicRules).toContain('Team org rule');
    expect(result.dynamicRules).toContain('--- Team Rules: my-team ---');
    expect(result.dynamicRules).toContain('Team-only rule');

    // Verify dynamic order
    const gpIdx = result.dynamicRules.indexOf('--- Org Rules: grandparent ---');
    const parentIdx = result.dynamicRules.indexOf('--- Org Rules: parent ---');
    const teamOrgIdx = result.dynamicRules.indexOf('--- Org Rules: my-team ---');
    const teamRulesIdx = result.dynamicRules.indexOf('--- Team Rules: my-team ---');
    expect(gpIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeGreaterThan(gpIdx);
    expect(teamOrgIdx).toBeGreaterThan(parentIdx);
    expect(teamRulesIdx).toBeGreaterThan(teamOrgIdx);

    // Static should NOT contain team-specific rules
    expect(result.staticRules).not.toContain('Grandparent rule');
    expect(result.staticRules).not.toContain('Team-only rule');
  });

  it('skips empty/missing levels gracefully', () => {
    // Only create team-rules, nothing else
    const teamRulesDir = join(runDir, 'teams', 'solo-team', 'team-rules');
    mkdirSync(teamRulesDir, { recursive: true });
    writeFileSync(join(teamRulesDir, '01-only.md'), '# Only\nThe only rule');

    const result = buildRuleCascade({
      teamName: 'solo-team',
      ancestors: [],
      runDir,
      dataDir,
      systemRulesDir,
    });

    expect(result.dynamicRules).toContain('--- Team Rules: solo-team ---');
    expect(result.dynamicRules).toContain('The only rule');
    expect(result.staticRules).toBe('');
  });

  it('returns empty strings when no rules exist anywhere', () => {
    const result = buildRuleCascade({
      teamName: 'ghost-team',
      ancestors: [],
      runDir,
      dataDir,
      systemRulesDir,
    });
    expect(result.staticRules).toBe('');
    expect(result.dynamicRules).toBe('');
  });
});

// ── Rule Conflict Validator ───────────────────────────────────────────────

describe('Rule Conflict Validator', () => {
  it('detects conflict for same topic at different levels without [OVERRIDE]', () => {
    const rules: AnnotatedRule[] = [
      { filename: 'tone.md', content: '# Communication Tone\nBe friendly', source: 'global' },
      { filename: 'tone.md', content: '# Communication Tone\nBe formal', source: 'team-org' },
    ];

    const result = validateRuleCascade(rules);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.topic).toBe('Communication Tone');
    expect(result.conflicts[0]?.sources).toEqual(['global', 'team-org']);
    expect(result.conflicts[0]?.hasOverride).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Communication Tone');
  });

  it('[OVERRIDE] suppresses conflict warning', () => {
    const rules: AnnotatedRule[] = [
      { filename: 'tone.md', content: '# Communication Tone\nBe friendly', source: 'global' },
      { filename: 'tone.md', content: '# Communication Tone\n[OVERRIDE] Be formal', source: 'team-org' },
    ];

    const result = validateRuleCascade(rules);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.hasOverride).toBe(true);
    // No warnings when override is present
    expect(result.warnings).toHaveLength(0);
  });

  it('returns no conflicts for unique topics', () => {
    const rules: AnnotatedRule[] = [
      { filename: 'safety.md', content: '# Safety\nBe safe', source: 'global' },
      { filename: 'tone.md', content: '# Tone\nBe friendly', source: 'team-org' },
    ];

    const result = validateRuleCascade(rules);

    expect(result.conflicts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('ignores rules without a heading', () => {
    const rules: AnnotatedRule[] = [
      { filename: 'no-heading.md', content: 'No heading here', source: 'global' },
      { filename: 'also-no-heading.md', content: 'Also no heading', source: 'team-org' },
    ];

    const result = validateRuleCascade(rules);

    expect(result.conflicts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('detects conflict across three levels', () => {
    const rules: AnnotatedRule[] = [
      { filename: 'log.md', content: '# Logging\nVerbose', source: 'global' },
      { filename: 'log.md', content: '# Logging\nMinimal', source: 'parent-org' },
      { filename: 'log.md', content: '# Logging\nDebug only', source: 'team-org' },
    ];

    const result = validateRuleCascade(rules);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.sources).toHaveLength(3);
    expect(result.warnings).toHaveLength(1);
  });
});
