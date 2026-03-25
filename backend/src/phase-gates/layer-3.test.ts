/**
 * Layer 3 Phase Gate — Rules + Domain
 *
 * Tests:
 * - UT-3: Rule loader reads .md files sorted, ignores non-.md, handles missing/empty dirs
 * - Rule cascade: concatenates global -> main org -> ancestor org -> team org -> team-rules
 * - [OVERRIDE] rules replace parent rules without conflict warning
 * - Conflicts detected for same-topic at different levels without [OVERRIDE]
 * - Org tree: addTeam, getTeam, getChildren, getAncestors (root->parent), isDescendant, removeTeam
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { loadRulesFromDirectory } from '../rules/loader.js';
import { buildRuleCascade } from '../rules/cascade.js';
import { validateRuleCascade } from '../rules/validator.js';
import type { AnnotatedRule } from '../rules/validator.js';
import { OrgTree } from '../domain/org-tree.js';
import type { IOrgStore } from '../domain/interfaces.js';
import type { OrgTreeNode } from '../domain/types.js';
import { TeamStatus } from '../domain/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-l3-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeNode(overrides: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return {
    parentId: null,
    status: TeamStatus.Idle,
    agents: [],
    children: [],
    ...overrides,
  };
}

/** Simple in-memory IOrgStore for testing OrgTree without SQLite. */
function createMemoryOrgStore(): IOrgStore {
  const data = new Map<string, OrgTreeNode>();

  return {
    addTeam(node: OrgTreeNode): void {
      data.set(node.teamId, node);
    },
    removeTeam(id: string): void {
      data.delete(id);
    },
    getTeam(id: string): OrgTreeNode | undefined {
      return data.get(id);
    },
    getChildren(parentId: string): OrgTreeNode[] {
      return [...data.values()].filter((n) => n.parentId === parentId);
    },
    getAncestors(id: string): OrgTreeNode[] {
      const ancestors: OrgTreeNode[] = [];
      let current = data.get(id);
      while (current?.parentId) {
        const parent = data.get(current.parentId);
        if (!parent) break;
        ancestors.push(parent);
        current = parent;
      }
      return ancestors;
    },
    getAll(): OrgTreeNode[] {
      return [...data.values()];
    },
    addScopeKeywords(): void {},
    removeScopeKeywords(): void {},
    getOwnScope(): string[] { return []; },
    getEffectiveScope(): string[] { return []; },
  };
}

// ── UT-3: Rule Loader ─────────────────────────────────────────────────────

describe('UT-3: Rule Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('reads .md files sorted by filename', () => {
    writeFileSync(join(tmpDir, 'b-rule.md'), '# B Rule\nContent B');
    writeFileSync(join(tmpDir, 'a-rule.md'), '# A Rule\nContent A');
    writeFileSync(join(tmpDir, 'c-rule.md'), '# C Rule\nContent C');

    const rules = loadRulesFromDirectory(tmpDir);
    expect(rules).toHaveLength(3);
    expect(rules[0]?.filename).toBe('a-rule.md');
    expect(rules[1]?.filename).toBe('b-rule.md');
    expect(rules[2]?.filename).toBe('c-rule.md');
    expect(rules[0]?.content).toBe('# A Rule\nContent A');
  });

  it('ignores non-.md files', () => {
    writeFileSync(join(tmpDir, 'valid.md'), '# Valid');
    writeFileSync(join(tmpDir, 'readme.txt'), 'not a rule');
    writeFileSync(join(tmpDir, 'config.yaml'), 'key: value');
    writeFileSync(join(tmpDir, '.hidden'), 'hidden');

    const rules = loadRulesFromDirectory(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.filename).toBe('valid.md');
  });

  it('returns empty array for missing directory', () => {
    const rules = loadRulesFromDirectory(join(tmpDir, 'nonexistent'));
    expect(rules).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir);

    const rules = loadRulesFromDirectory(emptyDir);
    expect(rules).toEqual([]);
  });

  it('returns empty array for directory with no .md files', () => {
    writeFileSync(join(tmpDir, 'data.json'), '{}');
    writeFileSync(join(tmpDir, 'notes.txt'), 'hello');

    const rules = loadRulesFromDirectory(tmpDir);
    expect(rules).toEqual([]);
  });
});

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

    // Verify section order
    const systemIdx = result.indexOf('--- System Rules ---');
    const orgIdx = result.indexOf('--- Organization Rules ---');
    const gpIdx = result.indexOf('--- Org Rules: grandparent ---');
    const parentIdx = result.indexOf('--- Org Rules: parent ---');
    const teamOrgIdx = result.indexOf('--- Org Rules: my-team ---');
    const teamRulesIdx = result.indexOf('--- Team Rules: my-team ---');

    expect(systemIdx).toBeGreaterThanOrEqual(0);
    expect(orgIdx).toBeGreaterThan(systemIdx);
    expect(gpIdx).toBeGreaterThan(orgIdx);
    expect(parentIdx).toBeGreaterThan(gpIdx);
    expect(teamOrgIdx).toBeGreaterThan(parentIdx);
    expect(teamRulesIdx).toBeGreaterThan(teamOrgIdx);

    // Verify content present
    expect(result).toContain('Global safety');
    expect(result).toContain('Main org rule');
    expect(result).toContain('Grandparent rule');
    expect(result).toContain('Parent rule');
    expect(result).toContain('Team org rule');
    expect(result).toContain('Team-only rule');
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

    expect(result).toContain('--- Team Rules: solo-team ---');
    expect(result).toContain('The only rule');
    expect(result).not.toContain('--- System Rules ---');
    expect(result).not.toContain('--- Organization Rules ---');
  });

  it('returns empty string when no rules exist anywhere', () => {
    const result = buildRuleCascade({
      teamName: 'ghost-team',
      ancestors: [],
      runDir,
      dataDir,
      systemRulesDir,
    });
    expect(result).toBe('');
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

// ── Org Tree ──────────────────────────────────────────────────────────────

describe('Org Tree', () => {
  let tree: OrgTree;
  let store: IOrgStore;

  beforeEach(() => {
    store = createMemoryOrgStore();
    tree = new OrgTree(store);
  });

  it('addTeam + getTeam round-trips', () => {
    const node = makeNode({ teamId: 'tid-root-001', name: 'root' });
    tree.addTeam(node);

    const result = tree.getTeam('tid-root-001');
    expect(result).toBeDefined();
    expect(result?.teamId).toBe('tid-root-001');
    expect(result?.name).toBe('root');
  });

  it('getTeam returns undefined for unknown id', () => {
    expect(tree.getTeam('nonexistent')).toBeUndefined();
  });

  it('getChildren returns direct children', () => {
    tree.addTeam(makeNode({ teamId: 'tid-parent', name: 'parent' }));
    tree.addTeam(makeNode({ teamId: 'tid-child-a', name: 'child-a', parentId: 'tid-parent' }));
    tree.addTeam(makeNode({ teamId: 'tid-child-b', name: 'child-b', parentId: 'tid-parent' }));
    tree.addTeam(makeNode({ teamId: 'tid-other', name: 'other' }));

    const children = tree.getChildren('tid-parent');
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.name).sort()).toEqual(['child-a', 'child-b']);
  });

  it('getAncestors returns root -> parent order', () => {
    tree.addTeam(makeNode({ teamId: 'tid-root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'tid-mid', name: 'mid', parentId: 'tid-root' }));
    tree.addTeam(makeNode({ teamId: 'tid-leaf', name: 'leaf', parentId: 'tid-mid' }));

    const ancestors = tree.getAncestors('tid-leaf');
    expect(ancestors).toHaveLength(2);
    // Root first (outermost), then mid (parent)
    expect(ancestors[0]?.name).toBe('root');
    expect(ancestors[1]?.name).toBe('mid');
  });

  it('getAncestors returns empty for root node', () => {
    tree.addTeam(makeNode({ teamId: 'tid-root', name: 'root' }));
    const ancestors = tree.getAncestors('tid-root');
    expect(ancestors).toHaveLength(0);
  });

  it('isDescendant returns true for child of ancestor', () => {
    tree.addTeam(makeNode({ teamId: 'tid-root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'tid-mid', name: 'mid', parentId: 'tid-root' }));
    tree.addTeam(makeNode({ teamId: 'tid-leaf', name: 'leaf', parentId: 'tid-mid' }));

    expect(tree.isDescendant('tid-leaf', 'tid-root')).toBe(true);
    expect(tree.isDescendant('tid-leaf', 'tid-mid')).toBe(true);
    expect(tree.isDescendant('tid-mid', 'tid-root')).toBe(true);
  });

  it('isDescendant returns false for non-ancestor', () => {
    tree.addTeam(makeNode({ teamId: 'tid-a', name: 'a' }));
    tree.addTeam(makeNode({ teamId: 'tid-b', name: 'b' }));

    expect(tree.isDescendant('tid-a', 'tid-b')).toBe(false);
    expect(tree.isDescendant('tid-b', 'tid-a')).toBe(false);
  });

  it('isDescendant returns false for self', () => {
    tree.addTeam(makeNode({ teamId: 'tid-a', name: 'a' }));
    expect(tree.isDescendant('tid-a', 'tid-a')).toBe(false);
  });

  it('removeTeam removes from tree and store', () => {
    tree.addTeam(makeNode({ teamId: 'tid-rm', name: 'doomed' }));
    expect(tree.getTeam('tid-rm')).toBeDefined();

    tree.removeTeam('tid-rm');
    expect(tree.getTeam('tid-rm')).toBeUndefined();
    expect(store.getTeam('tid-rm')).toBeUndefined();
  });

  it('loadFromStore populates tree from store', () => {
    // Add directly to store, bypassing tree
    store.addTeam(makeNode({ teamId: 'tid-pre', name: 'pre-existing' }));

    // Tree shouldn't have it yet
    expect(tree.getTeam('tid-pre')).toBeUndefined();

    // Load from store
    tree.loadFromStore();
    expect(tree.getTeam('tid-pre')).toBeDefined();
    expect(tree.getTeam('tid-pre')?.name).toBe('pre-existing');
  });

  it('loadFromStore clears previous in-memory state', () => {
    tree.addTeam(makeNode({ teamId: 'tid-mem', name: 'memory-only' }));

    // Remove from store directly but not from tree's cache
    store.removeTeam('tid-mem');

    // After reload, the memory-only node should be gone
    tree.loadFromStore();
    expect(tree.getTeam('tid-mem')).toBeUndefined();
  });
});
