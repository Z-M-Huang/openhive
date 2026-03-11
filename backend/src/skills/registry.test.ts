/**
 * Tests for SkillRegistry implementation.
 *
 * Tests verify shadow semantics, team isolation (INV-08), and snapshot
 * immutability.
 *
 * @module skills/registry.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistryImpl } from './registry.js';
import type { SkillDefinition } from '../domain/index.js';

describe('SkillRegistryImpl', () => {
  let registry: SkillRegistryImpl;

  // Helper to create a skill definition for testing
  function createSkill(name: string, description: string): SkillDefinition {
    return { name, description, body: `# Skill: ${name}\n\nContent here.` };
  }

  beforeEach(() => {
    registry = new SkillRegistryImpl();
  });

  describe('register and get', () => {
    it('registers and retrieves a skill for a team via get()', () => {
      const teamSlug = 'test-team';
      const skill = createSkill('test-skill', 'A test skill');

      registry.register(teamSlug, skill);

      const result = registry.get(teamSlug, 'test-skill');
      expect(result).toBeDefined();
      expect(result?.name).toBe('test-skill');
      expect(result?.description).toBe('A test skill');
    });

    it('get returns undefined for non-existent skill in empty team', () => {
      const result = registry.get('non-existent-team', 'non-existent-skill');
      expect(result).toBeUndefined();
    });
  });

  describe('shadow semantics', () => {
    it('team skill overrides common skill of same name', () => {
      // Register common skill
      const commonSkill = createSkill('shared-skill', 'Common skill');
      registry.register('__common__', commonSkill);

      // Register team-specific version
      const teamSkill = createSkill('shared-skill', 'Team-specific skill');
      registry.register('my-team', teamSkill);

      // Team skill should win
      const result = registry.get('my-team', 'shared-skill');
      expect(result?.description).toBe('Team-specific skill');
    });

    it('unregister team skill makes common version visible again via get()', () => {
      // Register common skill
      const commonSkill = createSkill('shadowable', 'Common version');
      registry.register('__common__', commonSkill);

      // Register team override
      const teamSkill = createSkill('shadowable', 'Team override');
      registry.register('my-team', teamSkill);

      // Verify team override is visible
      expect(registry.get('my-team', 'shadowable')?.description).toBe('Team override');

      // Unregister team skill
      registry.unregister('my-team', 'shadowable');

      // Common version should be visible again
      const result = registry.get('my-team', 'shadowable');
      expect(result?.description).toBe('Common version');
    });
  });

  describe('team isolation (INV-08)', () => {
    it('skills registered for team-A not visible to team-B', () => {
      const skillA = createSkill('team-a-skill', 'Skill for team A');
      const skillB = createSkill('team-b-skill', 'Skill for team B');

      registry.register('team-a', skillA);
      registry.register('team-b', skillB);

      // Team A should see its own skill but not team B's
      expect(registry.get('team-a', 'team-a-skill')).toBeDefined();
      expect(registry.get('team-a', 'team-b-skill')).toBeUndefined();

      // Team B should see its own skill but not team A's
      expect(registry.get('team-b', 'team-b-skill')).toBeDefined();
      expect(registry.get('team-b', 'team-a-skill')).toBeUndefined();
    });

    it('multiple teams can shadow the same common skill independently', () => {
      // Register common skill
      const commonSkill = createSkill('common', 'Original common skill');
      registry.register('__common__', commonSkill);

      // Register team-specific versions for different teams
      const teamASkill = createSkill('common', 'Team A override');
      const teamBSkill = createSkill('common', 'Team B override');

      registry.register('team-a', teamASkill);
      registry.register('team-b', teamBSkill);

      // Each team should see its own override
      expect(registry.get('team-a', 'common')?.description).toBe('Team A override');
      expect(registry.get('team-b', 'common')?.description).toBe('Team B override');
    });
  });

  describe('listForTeam', () => {
    it('listForTeam returns merged snapshot (common + team overlay)', () => {
      // Register common skills
      registry.register('__common__', createSkill('common-only', 'Common only'));
      registry.register('__common__', createSkill('shared', 'Shared skill'));

      // Register team-specific skills
      registry.register('my-team', createSkill('team-only', 'Team only'));
      registry.register('my-team', createSkill('shared', 'Team version of shared'));

      const skills = registry.listForTeam('my-team');
      const skillNames = skills.map(s => s.name);

      // Should include: common-only (from common), team-only (from team), shared (team version)
      expect(skillNames).toContain('common-only');
      expect(skillNames).toContain('team-only');
      expect(skillNames).toContain('shared');

      // Team version should win on shared skill
      const sharedSkill = skills.find(s => s.name === 'shared');
      expect(sharedSkill?.description).toBe('Team version of shared');
    });

    it('listForTeam snapshot is immutable', () => {
      registry.register('my-team', createSkill('skill1', 'First skill'));

      const skills = registry.listForTeam('my-team');
      const originalLength = skills.length;

      // Try to modify the returned array
      skills.push(createSkill('injected', 'Injected skill'));
      skills.splice(0, 1);

      // Get a fresh list and verify it wasn't affected
      const freshList = registry.listForTeam('my-team');
      expect(freshList.length).toBe(originalLength);
      expect(freshList.find(s => s.name === 'skill1')).toBeDefined();
      expect(freshList.find(s => s.name === 'injected')).toBeUndefined();
    });

    it('empty team with no team-specific skills returns only common skills', () => {
      // Register common skill
      registry.register('__common__', createSkill('common-skill', 'A common skill'));

      // Empty team (not registered in registry at all) - should still see common skills
      const skills = registry.listForTeam('empty-team');

      // Should return common skills (listForTeam merges common + team, even for new teams)
      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('common-skill');
    });
  });

  describe('unregister idempotency', () => {
    it('unregister is idempotent (no error on missing skill)', () => {
      // Should not throw
      expect(() => {
        registry.unregister('empty-team', 'non-existent-skill');
      }).not.toThrow();

      // Should not throw even when team doesn't exist
      expect(() => {
        registry.unregister('completely-unknown-team', 'some-skill');
      }).not.toThrow();
    });

    it('unregister removes skill (get returns undefined after)', () => {
      registry.register('my-team', createSkill('to-remove', 'Will be removed'));

      expect(registry.get('my-team', 'to-remove')).toBeDefined();

      registry.unregister('my-team', 'to-remove');

      expect(registry.get('my-team', 'to-remove')).toBeUndefined();
    });
  });

  describe('common skills fallback', () => {
    it('get returns common skill when team has no override', () => {
      // Register common skill only
      registry.register('__common__', createSkill('fallback-skill', 'Common fallback'));

      // Team with no specific skills should fall back to common
      const result = registry.get('brand-new-team', 'fallback-skill');
      expect(result?.description).toBe('Common fallback');
    });
  });
});