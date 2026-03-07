/**
 * Tests for writeSkillFile helper (tools-team.ts)
 *
 * Uses real temporary directories — no fs mocks — to test the actual
 * file creation behaviour and provide a round-trip verification against
 * SkillLoader.
 *
 * Covers:
 *   1. writeSkillFile creates the skill subdirectory
 *   2. writeSkillFile creates SKILL.md with correct YAML frontmatter
 *   3. writeSkillFile writes only non-empty optional fields into frontmatter
 *   4. writeSkillFile validates skill name — rejects empty string
 *   5. writeSkillFile validates skill name — rejects path traversal
 *   6. writeSkillFile validates skill name — rejects slash
 *   7. writeSkillFile validates skill name — rejects invalid characters
 *   8. Round-trip: file written by writeSkillFile is parsed correctly by SkillLoader
 *   9. Round-trip: full params including argumentHint and allowedTools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeSkillFile } from './tools-team.js';
import { SkillLoader } from './skills.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'openhive-write-skill-test-'));
}

function makeSilentLogger() {
  return {
    warn(_msg: string, _data?: Record<string, unknown>): void {
      // no-op
    },
  };
}

// ---------------------------------------------------------------------------
// writeSkillFile — directory and file creation
// ---------------------------------------------------------------------------

describe('writeSkillFile', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('creates the .claude/skills/<name> directory', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'web-search',
      body: 'Search the web for information.',
    });

    const skillDir = join(workspaceDir, '.claude', 'skills', 'web-search');
    expect(existsSync(skillDir)).toBe(true);
  });

  it('creates SKILL.md inside the skill directory', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'code-review',
      body: 'Review code thoroughly.',
    });

    const skillFile = join(workspaceDir, '.claude', 'skills', 'code-review', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
  });

  it('writes YAML frontmatter with name field', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'summarise',
      body: 'Summarise documents.',
    });

    const content = readFileSync(
      join(workspaceDir, '.claude', 'skills', 'summarise', 'SKILL.md'),
      'utf8',
    );

    expect(content).toContain('---');
    expect(content).toContain('name: summarise');
    // Body should appear after the closing frontmatter delimiter
    expect(content).toContain('Summarise documents.');
  });

  it('writes description into frontmatter when provided', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'researcher',
      description: 'Research topics thoroughly',
      body: 'Always cite sources.',
    });

    const content = readFileSync(
      join(workspaceDir, '.claude', 'skills', 'researcher', 'SKILL.md'),
      'utf8',
    );

    expect(content).toContain('description: Research topics thoroughly');
  });

  it('writes argument-hint into frontmatter when provided', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'query',
      argumentHint: 'the search query to execute',
      body: 'Execute the given query.',
    });

    const content = readFileSync(
      join(workspaceDir, '.claude', 'skills', 'query', 'SKILL.md'),
      'utf8',
    );

    expect(content).toContain('argument-hint:');
    expect(content).toContain('the search query to execute');
  });

  it('writes allowed-tools into frontmatter when provided', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'browser',
      allowedTools: ['browser_search', 'fetch_url'],
      body: 'Browse the web.',
    });

    const content = readFileSync(
      join(workspaceDir, '.claude', 'skills', 'browser', 'SKILL.md'),
      'utf8',
    );

    expect(content).toContain('allowed-tools:');
    expect(content).toContain('browser_search');
    expect(content).toContain('fetch_url');
  });

  it('omits optional fields from frontmatter when not provided', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'minimal',
      body: 'Minimal skill.',
    });

    const content = readFileSync(
      join(workspaceDir, '.claude', 'skills', 'minimal', 'SKILL.md'),
      'utf8',
    );

    expect(content).not.toContain('description:');
    expect(content).not.toContain('argument-hint:');
    expect(content).not.toContain('allowed-tools:');
  });

  it('omits empty string description from frontmatter', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'empty-desc',
      description: '',
      body: 'Body only.',
    });

    const content = readFileSync(
      join(workspaceDir, '.claude', 'skills', 'empty-desc', 'SKILL.md'),
      'utf8',
    );

    expect(content).not.toContain('description:');
  });

  it('omits empty allowedTools array from frontmatter', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'no-tools',
      allowedTools: [],
      body: 'Body only.',
    });

    const content = readFileSync(
      join(workspaceDir, '.claude', 'skills', 'no-tools', 'SKILL.md'),
      'utf8',
    );

    expect(content).not.toContain('allowed-tools:');
  });

  it('creates parent directories recursively when they do not exist', async () => {
    // The workspace dir exists but .claude/skills/ does not yet
    await writeSkillFile(workspaceDir, {
      name: 'deep-skill',
      body: 'Deep.',
    });

    expect(
      existsSync(join(workspaceDir, '.claude', 'skills', 'deep-skill', 'SKILL.md')),
    ).toBe(true);
  });

  // ---- Name validation -------------------------------------------------------

  it('throws ValidationError for empty skill name', async () => {
    await expect(
      writeSkillFile(workspaceDir, { name: '', body: 'Body.' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      writeSkillFile(workspaceDir, { name: '', body: 'Body.' }),
    ).rejects.toThrow('skill name cannot be empty');
  });

  it('throws ValidationError for skill name with path traversal (..)', async () => {
    await expect(
      writeSkillFile(workspaceDir, { name: '../etc/passwd', body: 'Body.' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      writeSkillFile(workspaceDir, { name: '../etc/passwd', body: 'Body.' }),
    ).rejects.toThrow("must not contain '..'");
  });

  it('throws ValidationError for skill name with forward slash', async () => {
    await expect(
      writeSkillFile(workspaceDir, { name: 'foo/bar', body: 'Body.' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      writeSkillFile(workspaceDir, { name: 'foo/bar', body: 'Body.' }),
    ).rejects.toThrow('must not contain path separators');
  });

  it('throws ValidationError for skill name with invalid characters', async () => {
    await expect(
      writeSkillFile(workspaceDir, { name: 'my skill!', body: 'Body.' }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: writeSkillFile → SkillLoader.loadSkill
// ---------------------------------------------------------------------------

describe('writeSkillFile round-trip via SkillLoader', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('file written by writeSkillFile is parsed correctly by SkillLoader (minimal)', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'web-search',
      body: 'Search the web for information.',
    });

    const loader = new SkillLoader(workspaceDir, makeSilentLogger());
    const skill = loader.loadSkill('web-search');

    expect(skill.name).toBe('web-search');
    expect(skill.system_prompt_addition).toBe('Search the web for information.');
  });

  it('file written by writeSkillFile is parsed correctly by SkillLoader (full params)', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'code-review',
      description: 'Review code for bugs and style',
      argumentHint: 'the code to review',
      allowedTools: ['read_file', 'write_file'],
      body: 'Be thorough. Always check edge cases.',
    });

    const loader = new SkillLoader(workspaceDir, makeSilentLogger());
    const skill = loader.loadSkill('code-review');

    expect(skill.name).toBe('code-review');
    expect(skill.description).toBe('Review code for bugs and style');
    // argument-hint and allowed-tools are Claude Code SDK fields not in the Skill interface,
    // so SkillLoader ignores them — but parsing must succeed without throwing.
    expect(skill.system_prompt_addition).toBe('Be thorough. Always check edge cases.');
  });

  it('loadAllSkills discovers skills written by writeSkillFile', async () => {
    await writeSkillFile(workspaceDir, {
      name: 'alpha',
      body: 'Alpha skill.',
    });
    await writeSkillFile(workspaceDir, {
      name: 'beta',
      description: 'Beta skill',
      body: 'Beta skill body.',
    });

    const loader = new SkillLoader(workspaceDir, makeSilentLogger());
    const skills = loader.loadAllSkills();

    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });
});
