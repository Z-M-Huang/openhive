/**
 * Layer 6 Phase Gate: SkillLoader + SkillRegistry tests.
 *
 * Tests SkillLoader workspace shadowing and CON-12 truncation,
 * SkillRegistry team-scoped isolation (INV-08).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NotFoundError } from '../domain/errors.js';
import { SkillLoaderImpl } from '../skills/loader.js';
import { SkillRegistryImpl } from '../skills/registry.js';

function createTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-l6-skills-'));
}

let tmpRoot: string;

describe('Layer 6: SkillLoader + SkillRegistry', () => {
  beforeEach(() => {
    tmpRoot = createTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('SkillLoader', () => {
    it('should load common skills', async () => {
      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      const skills = await loader.loadCommonSkills();
      expect(skills.length).toBeGreaterThanOrEqual(6);

      const names = skills.map((s) => s.name);
      expect(names).toContain('escalation');
      expect(names).toContain('health-report');
      expect(names).toContain('memory-management');
      expect(names).toContain('task-completion');
    });

    it('should load a single common skill by name', async () => {
      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      const skill = await loader.loadSkill(tmpRoot, 'escalation');
      expect(skill.name).toBe('escalation');
      expect(skill.description).toBeTruthy();
      expect(skill.allowedTools).toContain('escalate');
      expect(skill.body).toBeTruthy();
    });

    it('should throw NotFoundError for nonexistent skill', async () => {
      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      await expect(loader.loadSkill(tmpRoot, 'nonexistent-skill')).rejects.toThrow(NotFoundError);
    });

    it('should shadow common skill with workspace skill', async () => {
      // Create a workspace skill that overrides a common skill
      const wsSkillDir = path.join(tmpRoot, '.claude', 'skills', 'escalation');
      fs.mkdirSync(wsSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsSkillDir, 'SKILL.md'),
        [
          '---',
          'name: escalation',
          'description: Custom escalation for this team',
          'allowed-tools:',
          '  - escalate',
          '  - send_message',
          '---',
          '',
          '# Custom Escalation',
          '',
          'This is a team-specific override.',
        ].join('\n'),
      );

      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      // loadSkill should return workspace version
      const skill = await loader.loadSkill(tmpRoot, 'escalation');
      expect(skill.description).toBe('Custom escalation for this team');

      // loadAllSkills should also return workspace version
      const allSkills = await loader.loadAllSkills(tmpRoot);
      const escalation = allSkills.find((s) => s.name === 'escalation');
      expect(escalation).toBeDefined();
      expect(escalation!.description).toBe('Custom escalation for this team');

      // Other common skills should still be present
      const names = allSkills.map((s) => s.name);
      expect(names).toContain('health-report');
      expect(names).toContain('memory-management');
    });

    it('should truncate body at 500 lines (CON-12)', async () => {
      // Create a skill with >500 lines
      const longSkillDir = path.join(tmpRoot, '.claude', 'skills', 'long-skill');
      fs.mkdirSync(longSkillDir, { recursive: true });

      const bodyLines = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}: content here`);
      const content = [
        '---',
        'name: long-skill',
        'description: A skill with too many lines',
        '---',
        '',
        ...bodyLines,
      ].join('\n');

      fs.writeFileSync(path.join(longSkillDir, 'SKILL.md'), content);

      const loader = new SkillLoaderImpl({
        commonSkillsPath: tmpRoot + '/empty-common',
      });

      const skill = await loader.loadSkill(tmpRoot, 'long-skill');
      const loadedLines = skill.body.split('\n');
      expect(loadedLines.length).toBeLessThanOrEqual(500);
      // The first body line after frontmatter is empty, then "Line 1: ..."
      expect(loadedLines[loadedLines.length - 1]).toContain('Line');
    });

    it('should parse all frontmatter fields correctly', async () => {
      const skillDir = path.join(tmpRoot, '.claude', 'skills', 'full-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: full-skill',
          'description: Skill with all frontmatter fields',
          'argument-hint: "<file_path> [--strict]"',
          'allowed-tools:',
          '  - Read',
          '  - Grep',
          'model: sonnet',
          'user-invocable: true',
          'disable-model-invocation: true',
          '---',
          '',
          '# Full Skill Body',
        ].join('\n'),
      );

      const loader = new SkillLoaderImpl({
        commonSkillsPath: tmpRoot + '/empty-common',
      });

      const skill = await loader.loadSkill(tmpRoot, 'full-skill');
      expect(skill.name).toBe('full-skill');
      expect(skill.description).toBe('Skill with all frontmatter fields');
      expect(skill.argumentHint).toBe('<file_path> [--strict]');
      expect(skill.allowedTools).toEqual(['Read', 'Grep']);
      expect(skill.model).toBe('sonnet');
      expect(skill.userInvocable).toBe(true);
      expect(skill.disableModelInvocation).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 7. SkillRegistry team-scoped isolation (INV-08)
  // -------------------------------------------------------------------------

  describe('SkillRegistry (INV-08)', () => {
    it('should isolate skills between teams', () => {
      const registry = new SkillRegistryImpl();

      registry.register('team-a', {
        name: 'custom-review',
        description: 'Team A code review',
        body: 'Review code for Team A standards',
      });

      registry.register('team-b', {
        name: 'custom-review',
        description: 'Team B code review',
        body: 'Review code for Team B standards',
      });

      const skillA = registry.get('team-a', 'custom-review');
      const skillB = registry.get('team-b', 'custom-review');

      expect(skillA!.description).toBe('Team A code review');
      expect(skillB!.description).toBe('Team B code review');
    });

    it('should return defensive copies from get()', () => {
      const registry = new SkillRegistryImpl();
      registry.register('my-team', {
        name: 'test-skill',
        description: 'Original',
        body: 'Body',
      });

      const copy1 = registry.get('my-team', 'test-skill');
      const copy2 = registry.get('my-team', 'test-skill');

      // Mutating one copy should not affect the other
      copy1!.description = 'Mutated';
      expect(copy2!.description).toBe('Original');
    });

    it('should shadow common skills with team skills in listForTeam()', () => {
      const registry = new SkillRegistryImpl();

      // Register common skill
      registry.register('__common__', {
        name: 'escalation',
        description: 'Common escalation skill',
        body: 'Default escalation behavior',
      });

      // Team override
      registry.register('my-team', {
        name: 'escalation',
        description: 'Custom escalation for my-team',
        body: 'Custom behavior',
      });

      const skills = registry.listForTeam('my-team');
      const escalation = skills.find((s) => s.name === 'escalation');
      expect(escalation).toBeDefined();
      expect(escalation!.description).toBe('Custom escalation for my-team');
    });

    it('should unregister team skill and fall back to common', () => {
      const registry = new SkillRegistryImpl();

      registry.register('__common__', {
        name: 'memory-management',
        description: 'Common memory management',
        body: 'Default memory behavior',
      });

      registry.register('my-team', {
        name: 'memory-management',
        description: 'Custom memory for my-team',
        body: 'Custom memory behavior',
      });

      // Team version visible
      let skill = registry.get('my-team', 'memory-management');
      expect(skill!.description).toBe('Custom memory for my-team');

      // Unregister team version
      registry.unregister('my-team', 'memory-management');

      // Common version should be visible again
      skill = registry.get('my-team', 'memory-management');
      expect(skill!.description).toBe('Common memory management');
    });
  });

});
