import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoaderImpl } from './loader.js';
import { NotFoundError } from '../domain/index.js';

describe('SkillLoaderImpl', () => {
  let tmpDir: string;
  let workspacePath: string;
  let commonPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'skill-loader-'));
    workspacePath = join(tmpDir, 'workspace');
    commonPath = join(tmpDir, 'common');
    await mkdir(join(workspacePath, '.claude/skills'), { recursive: true });
    await mkdir(commonPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeSkillFile(dir: string, name: string, content: string): Promise<void> {
    const skillDir = join(dir, name);
    return mkdir(skillDir, { recursive: true }).then(() =>
      writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8'),
    );
  }

  const SAMPLE_SKILL = `---
name: code-review
description: "Reviews code for quality"
allowed-tools:
  - Read
  - Grep
model: sonnet
user-invocable: true
argument-hint: "<file>"
---

# Code Review

Review the provided code.
`;

  describe('loadSkill()', () => {
    it('loads a skill from the workspace', async () => {
      await makeSkillFile(join(workspacePath, '.claude/skills'), 'code-review', SAMPLE_SKILL);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skill = await loader.loadSkill(workspacePath, 'code-review');

      expect(skill.name).toBe('code-review');
      expect(skill.description).toBe('Reviews code for quality');
      expect(skill.allowedTools).toEqual(['Read', 'Grep']);
      expect(skill.model).toBe('sonnet');
      expect(skill.userInvocable).toBe(true);
      expect(skill.argumentHint).toBe('<file>');
      expect(skill.body).toContain('# Code Review');
    });

    it('falls back to common skills', async () => {
      await makeSkillFile(commonPath, 'escalation', SAMPLE_SKILL);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skill = await loader.loadSkill(workspacePath, 'escalation');
      expect(skill.name).toBe('code-review'); // name comes from frontmatter
    });

    it('workspace shadows common', async () => {
      await makeSkillFile(commonPath, 'my-skill', `---\nname: my-skill\ndescription: common version\n---\nCommon body\n`);
      await makeSkillFile(join(workspacePath, '.claude/skills'), 'my-skill', `---\nname: my-skill\ndescription: workspace version\n---\nWorkspace body\n`);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skill = await loader.loadSkill(workspacePath, 'my-skill');
      expect(skill.description).toBe('workspace version');
      expect(skill.body).toContain('Workspace body');
    });

    it('throws NotFoundError for missing skill', async () => {
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });
      await expect(loader.loadSkill(workspacePath, 'nonexistent')).rejects.toThrow(NotFoundError);
    });
  });

  describe('loadAllSkills()', () => {
    it('merges workspace and common skills', async () => {
      await makeSkillFile(commonPath, 'common-skill', `---\nname: common-skill\ndescription: from common\n---\nBody\n`);
      await makeSkillFile(join(workspacePath, '.claude/skills'), 'ws-skill', `---\nname: ws-skill\ndescription: from workspace\n---\nBody\n`);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skills = await loader.loadAllSkills(workspacePath);
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(['common-skill', 'ws-skill']);
    });

    it('workspace shadows common by name', async () => {
      await makeSkillFile(commonPath, 'shared', `---\nname: shared\ndescription: common\n---\nCommon\n`);
      await makeSkillFile(join(workspacePath, '.claude/skills'), 'shared', `---\nname: shared\ndescription: override\n---\nOverride\n`);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skills = await loader.loadAllSkills(workspacePath);
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe('override');
    });

    it('returns empty array when no skills exist', async () => {
      const loader = new SkillLoaderImpl({ commonSkillsPath: join(tmpDir, 'nonexistent') });
      const skills = await loader.loadAllSkills(join(tmpDir, 'also-nonexistent'));
      expect(skills).toEqual([]);
    });
  });

  describe('loadCommonSkills()', () => {
    it('loads all common skills', async () => {
      await makeSkillFile(commonPath, 'skill-a', `---\nname: skill-a\ndescription: A\n---\nA body\n`);
      await makeSkillFile(commonPath, 'skill-b', `---\nname: skill-b\ndescription: B\n---\nB body\n`);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skills = await loader.loadCommonSkills();
      expect(skills).toHaveLength(2);
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(['skill-a', 'skill-b']);
    });
  });

  describe('CON-12: body truncation', () => {
    it('truncates body at 500 lines', async () => {
      const bodyLines = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`).join('\n');
      const content = `---\nname: long-skill\ndescription: long\n---\n${bodyLines}\n`;
      await makeSkillFile(join(workspacePath, '.claude/skills'), 'long-skill', content);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skill = await loader.loadSkill(workspacePath, 'long-skill');
      const lineCount = skill.body.split('\n').length;
      expect(lineCount).toBe(500);
      expect(skill.body).toContain('Line 1');
      expect(skill.body).not.toContain('Line 501');
    });
  });

  describe('frontmatter parsing', () => {
    it('handles missing frontmatter', async () => {
      await makeSkillFile(join(workspacePath, '.claude/skills'), 'no-fm', '# Just Markdown\n\nBody text.\n');
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skill = await loader.loadSkill(workspacePath, 'no-fm');
      expect(skill.name).toBe('no-fm'); // falls back to directory name
      expect(skill.description).toBe('');
      expect(skill.body).toContain('# Just Markdown');
    });

    it('parses all optional fields', async () => {
      const content = `---
name: full-skill
description: "Full featured"
argument-hint: "<args>"
allowed-tools:
  - Read
  - Write
model: opus
context: fork
agent: specialist
disable-model-invocation: true
user-invocable: true
---

Body content.
`;
      await makeSkillFile(join(workspacePath, '.claude/skills'), 'full-skill', content);
      const loader = new SkillLoaderImpl({ commonSkillsPath: commonPath });

      const skill = await loader.loadSkill(workspacePath, 'full-skill');
      expect(skill.argumentHint).toBe('<args>');
      expect(skill.allowedTools).toEqual(['Read', 'Write']);
      expect(skill.model).toBe('opus');
      expect(skill.context).toBe('fork');
      expect(skill.agent).toBe('specialist');
      expect(skill.disableModelInvocation).toBe(true);
      expect(skill.userInvocable).toBe(true);
    });
  });
});
