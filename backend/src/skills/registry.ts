/**
 * Skill registry for OpenHive — manages available skills per team.
 *
 * // INV-08: Team-scoped skill copies
 *
 * ## Skill Resolution Order
 *
 * When resolving skills for a team, the registry uses the following priority:
 *
 * 1. **Team workspace skills** — loaded from `<workspace>/.claude/skills/`
 * 2. **Common skills** — loaded from `/app/common/skills/`
 *
 * Team-local skills **shadow** common skills by name. This is a full file
 * shadow, not a merge: if a team registers a skill with the same name as a
 * common skill, the team's version completely replaces the common one for
 * that team. Other teams continue to see the common version.
 *
 * ## INV-08 Enforcement
 *
 * Each team maintains its own isolated copy of skill definitions. Mutations
 * to one team's skills (register/unregister) never affect another team's
 * available skills. Common skills serve as the base layer that all teams
 * inherit, but team-scoped registrations take precedence.
 *
 * @module skills/registry
 */

/**
 * Common team slug used to store shared skills available to all teams.
 * Underscore prefix prevents collision with valid team slugs per regex ^[a-z0-9]+(-[a-z0-9]+)*$.
 */
const COMMON_TEAM_SLUG = '__common__';

import type { SkillRegistry, SkillDefinition } from '../domain/index.js';

/**
 * Implementation of the {@link SkillRegistry} interface.
 *
 * Maintains per-team skill registrations with shadowing semantics:
 * team-local skills override common skills of the same name (full file
 * shadow, not merge). Common skills are registered under a reserved
 * internal team slug and serve as defaults for all teams.
 *
 * // INV-08: Team-scoped skill copies
 */
export class SkillRegistryImpl implements SkillRegistry {
  private readonly skills = new Map<string, Map<string, SkillDefinition>>();

  /**
   * Registers a skill definition for a specific team.
   *
   * If a skill with the same name already exists for the team, it is
   * replaced. Team-registered skills shadow common skills of the same
   * name (INV-08: full file shadow, not merge).
   *
   * @param teamSlug - The team slug to register the skill under
   * @param skill - The skill definition to register
   */
  register(teamSlug: string, skill: SkillDefinition): void {
    // INV-08: Team-scoped skill copies
    let teamMap = this.skills.get(teamSlug);
    if (!teamMap) {
      teamMap = new Map<string, SkillDefinition>();
      this.skills.set(teamSlug, teamMap);
    }
    teamMap.set(skill.name, skill);
  }

  /**
   * Removes a skill registration for a specific team.
   *
   * After removal, if a common skill with the same name exists, it
   * becomes visible again for the team (the shadow is lifted).
   *
   * @param teamSlug - The team slug to remove the skill from
   * @param skillName - The name of the skill to unregister
   */
  unregister(teamSlug: string, skillName: string): void {
    // INV-08: Team-scoped skill copies
    const teamMap = this.skills.get(teamSlug);
    if (teamMap) {
      teamMap.delete(skillName);
    }
  }

  /**
   * Resolves a single skill by name for a team.
   *
   * Resolution order:
   * 1. Team-specific registration (workspace override)
   * 2. Common skill registration (shared default)
   *
   * Returns `undefined` if no skill with the given name is found
   * in either location.
   *
   * @param teamSlug - The team slug to resolve the skill for
   * @param skillName - The name of the skill to look up
   * @returns The resolved skill definition, or `undefined` if not found
   */
  get(teamSlug: string, skillName: string): SkillDefinition | undefined {
    // INV-08: Team-scoped skill copies
    // First check team-specific skills
    const teamMap = this.skills.get(teamSlug);
    if (teamMap) {
      const skill = teamMap.get(skillName);
      if (skill) return skill;
    }
    // Fall back to common skills
    const commonMap = this.skills.get(COMMON_TEAM_SLUG);
    if (commonMap) {
      return commonMap.get(skillName);
    }
    return undefined;
  }

  /**
   * Lists all skills available to a team.
   *
   * Returns the merged view: all common skills plus any team-specific
   * overrides. When a team has a skill with the same name as a common
   * skill, the team's version is included (full file shadow, not merge).
   *
   * The returned array is a snapshot; modifications to it do not affect
   * the registry.
   *
   * @param teamSlug - The team slug to list skills for
   * @returns Array of all skill definitions available to the team
   */
  listForTeam(teamSlug: string): SkillDefinition[] {
    // INV-08: Team-scoped skill copies
    const merged = new Map<string, SkillDefinition>();

    // Copy all common skills first
    const commonMap = this.skills.get(COMMON_TEAM_SLUG);
    if (commonMap) {
      for (const [name, skill] of commonMap) {
        merged.set(name, { ...skill });
      }
    }

    // Overlay team-specific skills (team wins on collision)
    const teamMap = this.skills.get(teamSlug);
    if (teamMap) {
      for (const [name, skill] of teamMap) {
        merged.set(name, { ...skill });
      }
    }

    // Return defensive copy (objects already cloned above)
    return Array.from(merged.values());
  }
}
