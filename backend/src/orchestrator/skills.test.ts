/**
 * Tests for SkillLoader, validateSkill, validateSkillName.
 *
 * Uses real temporary directories written to disk (mkdtempSync) and cleaned
 * up in afterEach. No mocks for file system — the loader is synchronous and
 * straightforward to test with real files.
 *
 * Skills are stored as: <workspaceBase>/.claude/skills/<name>/SKILL.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SkillLoader, validateSkill, validateSkillName } from './skills.js';
import type { SkillLoaderLogger } from './skills.js';
import type { Skill } from '../domain/types.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a silent no-op logger for tests. */
function makeLogger(): SkillLoaderLogger & { warnings: Array<{ msg: string; data?: Record<string, unknown> }> } {
  const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  return {
    warnings,
    warn(msg: string, data?: Record<string, unknown>): void {
      warnings.push({ msg, data });
    },
  };
}

/** Creates a temp directory representing a workspace root. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'openhive-skills-test-'));
}

/**
 * Creates the .claude/skills directory under workspaceBase.
 * Returns the path to the .claude/skills directory.
 */
function makeSkillsDir(workspaceBase: string): string {
  const skillsDir = join(workspaceBase, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return skillsDir;
}

/**
 * Creates a skill directory and writes a SKILL.md file inside it.
 * Returns the path to the skill's directory.
 */
function makeSkillFile(skillsDir: string, skillName: string, content: string): string {
  const skillDir = join(skillsDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
  return skillDir;
}

// ---------------------------------------------------------------------------
// validateSkillName
// ---------------------------------------------------------------------------

describe('validateSkillName', () => {
  it('accepts valid names with letters, digits, hyphens, and underscores', () => {
    expect(() => validateSkillName('web-search')).not.toThrow();
    expect(() => validateSkillName('code_review')).not.toThrow();
    expect(() => validateSkillName('mySkill123')).not.toThrow();
    expect(() => validateSkillName('A')).not.toThrow();
  });

  it('throws ValidationError for empty name', () => {
    expect(() => validateSkillName('')).toThrow(ValidationError);
    expect(() => validateSkillName('')).toThrow('skill name cannot be empty');
  });

  it('throws ValidationError for names containing path traversal (..)', () => {
    expect(() => validateSkillName('../etc/passwd')).toThrow(ValidationError);
    expect(() => validateSkillName('../etc/passwd')).toThrow("must not contain '..'");
  });

  it('throws ValidationError for names containing forward slash', () => {
    expect(() => validateSkillName('foo/bar')).toThrow(ValidationError);
    expect(() => validateSkillName('foo/bar')).toThrow('must not contain path separators');
  });

  it('throws ValidationError for names containing backslash', () => {
    expect(() => validateSkillName('foo\\bar')).toThrow(ValidationError);
  });

  it('throws ValidationError for names containing spaces or special characters', () => {
    expect(() => validateSkillName('my skill')).toThrow(ValidationError);
    expect(() => validateSkillName('skill!')).toThrow(ValidationError);
    expect(() => validateSkillName('skill.yaml')).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// validateSkill
// ---------------------------------------------------------------------------

describe('validateSkill', () => {
  it('accepts a minimal valid skill with just a name', () => {
    const skill: Skill = { name: 'web-search' };
    expect(() => validateSkill(skill)).not.toThrow();
  });

  it('accepts a fully-populated valid skill', () => {
    const skill: Skill = {
      name: 'code_review',
      description: 'Review code for bugs',
      model_tier: 'sonnet',
      tools: ['read_file', 'write_file'],
      system_prompt_addition: 'Be thorough.',
    };
    expect(() => validateSkill(skill)).not.toThrow();
  });

  it('throws ValidationError when name is empty', () => {
    const skill: Skill = { name: '' };
    expect(() => validateSkill(skill)).toThrow(ValidationError);
    expect(() => validateSkill(skill)).toThrow('skill name is required');
  });

  it('throws ValidationError for invalid model_tier', () => {
    const skill: Skill = { name: 'my-skill', model_tier: 'mega' };
    expect(() => validateSkill(skill)).toThrow(ValidationError);
    expect(() => validateSkill(skill)).toThrow('invalid model_tier');
    expect(() => validateSkill(skill)).toThrow('haiku, sonnet, or opus');
  });

  it('accepts all valid model tiers', () => {
    for (const tier of ['haiku', 'sonnet', 'opus'] as const) {
      const skill: Skill = { name: 'my-skill', model_tier: tier };
      expect(() => validateSkill(skill)).not.toThrow();
    }
  });

  it('throws ValidationError for invalid tool name containing a space', () => {
    const skill: Skill = { name: 'my-skill', tools: ['bad tool'] };
    expect(() => validateSkill(skill)).toThrow(ValidationError);
    expect(() => validateSkill(skill)).toThrow('invalid tool name');
  });

  it('throws ValidationError for empty tool name', () => {
    const skill: Skill = { name: 'my-skill', tools: [''] };
    expect(() => validateSkill(skill)).toThrow(ValidationError);
    expect(() => validateSkill(skill)).toThrow('invalid tool name');
  });

  it('accepts valid tool names with letters, digits, and underscores', () => {
    const skill: Skill = { name: 'my-skill', tools: ['read_file', 'writeFile', 'tool123'] };
    expect(() => validateSkill(skill)).not.toThrow();
  });

  it('throws ValidationError for tool name containing a hyphen', () => {
    // Tool names only allow alphanumerics + underscore (no hyphens)
    const skill: Skill = { name: 'my-skill', tools: ['bad-tool'] };
    expect(() => validateSkill(skill)).toThrow(ValidationError);
    expect(() => validateSkill(skill)).toThrow('invalid tool name');
  });
});

// ---------------------------------------------------------------------------
// SkillLoader.loadSkill
// ---------------------------------------------------------------------------

describe('SkillLoader.loadSkill', () => {
  let workspaceBase: string;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    workspaceBase = makeTempDir();
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(workspaceBase, { recursive: true, force: true });
  });

  // ---- SKILL.md with YAML front-matter ------------------------------------

  it('loadSkill parses SKILL.md with YAML front-matter', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(
      skillsDir,
      'web-search',
      [
        '---',
        'name: web-search',
        'description: Search the web',
        'model_tier: haiku',
        'tools:',
        '  - browser_search',
        '---',
        'Use DuckDuckGo.',
      ].join('\n'),
    );

    const loader = new SkillLoader(workspaceBase, logger);
    const skill = loader.loadSkill('web-search');

    expect(skill.name).toBe('web-search');
    expect(skill.description).toBe('Search the web');
    expect(skill.model_tier).toBe('haiku');
    expect(skill.tools).toEqual(['browser_search']);
    expect(skill.system_prompt_addition).toBe('Use DuckDuckGo.');
  });

  it('loadSkill parses SKILL.md with sonnet model tier', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(
      skillsDir,
      'code-review',
      '---\nname: code-review\nmodel_tier: sonnet\n---\nReview thoroughly.',
    );

    const loader = new SkillLoader(workspaceBase, logger);
    const skill = loader.loadSkill('code-review');

    expect(skill.name).toBe('code-review');
    expect(skill.model_tier).toBe('sonnet');
  });

  it('uses directory name as skill name when name field is absent in front-matter', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(
      skillsDir,
      'summariser',
      '---\nmodel_tier: haiku\n---\nSummarise documents.',
    );

    const loader = new SkillLoader(workspaceBase, logger);
    const skill = loader.loadSkill('summariser');

    expect(skill.name).toBe('summariser');
    expect(skill.model_tier).toBe('haiku');
  });

  // ---- SKILL.md without front-matter --------------------------------------

  it('loadSkill parses SKILL.md without front-matter as system_prompt_addition only', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(skillsDir, 'writer', 'Write clear, concise prose.');

    const loader = new SkillLoader(workspaceBase, logger);
    const skill = loader.loadSkill('writer');

    // name is set from directory name
    expect(skill.name).toBe('writer');
    expect(skill.system_prompt_addition).toBe('Write clear, concise prose.');
  });

  it('loadSkill parses SKILL.md with front-matter and body', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(
      skillsDir,
      'researcher',
      [
        '---',
        'name: researcher',
        'model_tier: sonnet',
        '---',
        'You are an expert researcher. Always cite sources.',
      ].join('\n'),
    );

    const loader = new SkillLoader(workspaceBase, logger);
    const skill = loader.loadSkill('researcher');

    expect(skill.name).toBe('researcher');
    expect(skill.model_tier).toBe('sonnet');
    expect(skill.system_prompt_addition).toBe('You are an expert researcher. Always cite sources.');
  });

  // ---- NotFoundError -------------------------------------------------------

  it('throws NotFoundError when skill directory does not exist', () => {
    makeSkillsDir(workspaceBase);

    const loader = new SkillLoader(workspaceBase, logger);
    expect(() => loader.loadSkill('nonexistent')).toThrow(NotFoundError);
    expect(() => loader.loadSkill('nonexistent')).toThrow('nonexistent');
  });

  it('throws NotFoundError when SKILL.md is missing from skill directory', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    // Create the directory but no SKILL.md
    mkdirSync(join(skillsDir, 'empty-skill'));

    const loader = new SkillLoader(workspaceBase, logger);
    expect(() => loader.loadSkill('empty-skill')).toThrow(NotFoundError);
  });

  // ---- ValidationError on skillName ----------------------------------------

  it('throws ValidationError for invalid skillName with path traversal', () => {
    const loader = new SkillLoader(workspaceBase, logger);
    expect(() => loader.loadSkill('../evil')).toThrow(ValidationError);
  });

  it('throws ValidationError for invalid skillName with spaces', () => {
    const loader = new SkillLoader(workspaceBase, logger);
    expect(() => loader.loadSkill('bad name')).toThrow(ValidationError);
  });

  // ---- Parse error wrapping ------------------------------------------------

  it('wraps YAML front-matter parse errors with skill name context', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(skillsDir, 'broken', '---\n: invalid: yaml: [\n---\nbody');

    const loader = new SkillLoader(workspaceBase, logger);
    expect(() => loader.loadSkill('broken')).toThrow('failed to parse skill broken');
  });

  // ---- Skill validation on load -------------------------------------------

  it('throws when loaded skill has an invalid model_tier', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(
      skillsDir,
      'bad-tier',
      '---\nname: bad-tier\nmodel_tier: mega\n---\nContent.',
    );

    const loader = new SkillLoader(workspaceBase, logger);
    expect(() => loader.loadSkill('bad-tier')).toThrow('model_tier');
  });
});

// ---------------------------------------------------------------------------
// SkillLoader.loadAllSkills
// ---------------------------------------------------------------------------

describe('SkillLoader.loadAllSkills', () => {
  let workspaceBase: string;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    workspaceBase = makeTempDir();
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(workspaceBase, { recursive: true, force: true });
  });

  it('returns empty array when .claude/skills directory does not exist', () => {
    // Only create the workspace root, not the .claude/skills dir.
    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toEqual([]);
  });

  it('returns empty array when .claude/skills directory is empty', () => {
    makeSkillsDir(workspaceBase);

    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toEqual([]);
  });

  it('loadAllSkills reads SKILL.md from subdirectories', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(skillsDir, 'search', '---\nname: search\nmodel_tier: haiku\n---\nSearch.');
    makeSkillFile(skillsDir, 'review', '---\nname: review\nmodel_tier: sonnet\n---\nReview.');
    makeSkillFile(skillsDir, 'writer', '---\nname: writer\nmodel_tier: opus\n---\nWrite well.');

    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['review', 'search', 'writer']);
  });

  it('loadAllSkills skips non-directory entries (files at skills root)', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    // These files should be skipped — only subdirectories are skill entries.
    writeFileSync(join(skillsDir, 'README.txt'), 'This is a readme.', 'utf8');
    writeFileSync(join(skillsDir, 'notes.md'), 'Some notes.', 'utf8');
    writeFileSync(join(skillsDir, 'search.yaml'), 'name: search\n', 'utf8');
    // Valid skill directory
    makeSkillFile(skillsDir, 'code-review', '---\nname: code-review\n---\nReview code.');

    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('code-review');
  });

  it('loadAllSkills logs a warning and skips skill directories with invalid names', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    // Valid skill
    makeSkillFile(skillsDir, 'valid-skill', '---\nname: valid-skill\n---\nContent.');
    // Invalid directory name (contains dot — not allowed by validateSkillName)
    const badDir = join(skillsDir, 'bad.name');
    mkdirSync(badDir);
    writeFileSync(join(badDir, 'SKILL.md'), '---\nname: bad\n---\nContent.', 'utf8');

    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('valid-skill');
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(logger.warnings[0]!.msg).toContain('invalid base name');
  });

  it('logs a warning and skips skills that fail validation', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(skillsDir, 'valid', '---\nname: valid\nmodel_tier: haiku\n---\nContent.');
    makeSkillFile(
      skillsDir,
      'bad-tier',
      '---\nname: bad-tier\nmodel_tier: mega\n---\nContent.',
    );

    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('valid');
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  it('logs a warning and skips skill directories missing SKILL.md', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(skillsDir, 'good', '---\nname: good\n---\nContent.');
    // Create a directory without SKILL.md
    mkdirSync(join(skillsDir, 'no-file'));

    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('good');
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  it('loads skills from multiple directories with different content', () => {
    const skillsDir = makeSkillsDir(workspaceBase);
    makeSkillFile(skillsDir, 'alpha', '---\nname: alpha\nmodel_tier: haiku\n---\nAlpha content.');
    makeSkillFile(skillsDir, 'beta', '---\nmodel_tier: sonnet\n---\nBeta content.');
    makeSkillFile(skillsDir, 'gamma', 'Gamma content without frontmatter.');

    const loader = new SkillLoader(workspaceBase, logger);
    const skills = loader.loadAllSkills();

    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);

    const alpha = skills.find((s) => s.name === 'alpha')!;
    expect(alpha.model_tier).toBe('haiku');

    const beta = skills.find((s) => s.name === 'beta')!;
    // Name falls back to directory name
    expect(beta.name).toBe('beta');
    expect(beta.model_tier).toBe('sonnet');

    const gamma = skills.find((s) => s.name === 'gamma')!;
    expect(gamma.system_prompt_addition).toBe('Gamma content without frontmatter.');
  });
});
