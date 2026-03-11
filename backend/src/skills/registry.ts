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
  /**
   * Registers a skill definition for a specific team.
   *
   * If a skill with the same name already exists for the team, it is
   * replaced. Team-registered skills shadow common skills of the same
   * name (INV-08: full file shadow, not merge).
   *
   * @param _teamSlug - The team slug to register the skill under
   * @param _skill - The skill definition to register
   */
  register(_teamSlug: string, _skill: SkillDefinition): void {
    // INV-08: Team-scoped skill copies
    throw new Error('Not implemented');
  }

  /**
   * Removes a skill registration for a specific team.
   *
   * After removal, if a common skill with the same name exists, it
   * becomes visible again for the team (the shadow is lifted).
   *
   * @param _teamSlug - The team slug to remove the skill from
   * @param _skillName - The name of the skill to unregister
   */
  unregister(_teamSlug: string, _skillName: string): void {
    // INV-08: Team-scoped skill copies
    throw new Error('Not implemented');
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
   * @param _teamSlug - The team slug to resolve the skill for
   * @param _skillName - The name of the skill to look up
   * @returns The resolved skill definition, or `undefined` if not found
   */
  get(_teamSlug: string, _skillName: string): SkillDefinition | undefined {
    // INV-08: Team-scoped skill copies
    throw new Error('Not implemented');
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
   * @param _teamSlug - The team slug to list skills for
   * @returns Array of all skill definitions available to the team
   */
  listForTeam(_teamSlug: string): SkillDefinition[] {
    // INV-08: Team-scoped skill copies
    throw new Error('Not implemented');
  }
}
