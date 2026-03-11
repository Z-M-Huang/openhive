/**
 * Skill loader for OpenHive — discovers and parses SKILL.md files.
 *
 * ## Skill Discovery
 *
 * Skills are loaded from two locations, searched in priority order:
 *
 * 1. **Workspace skills** — `<workspace>/.claude/skills/` (team-specific overrides)
 * 2. **Common skills**  — `/app/common/skills/` (shared across all teams)
 *
 * When both locations contain a skill with the same name, the workspace copy
 * takes precedence (team override). Common skills serve as defaults for all
 * teams and include: escalation, health-report, integration-usage,
 * memory-management, system-smoke, and task-completion.
 *
 * ## SKILL.md Format
 *
 * Each skill is a Markdown file with YAML frontmatter:
 *
 * ```markdown
 * ---
 * name: code-review
 * description: Reviews code for quality and correctness
 * argument_hint: "<file_path> [--strict]"
 * allowed_tools:
 *   - Read
 *   - Grep
 *   - Glob
 * model: sonnet
 * ---
 *
 * # Code Review Instructions
 *
 * Review the provided code for ...
 * ```
 *
 * The frontmatter fields map to {@link SkillDefinition} properties. The
 * Markdown body (everything after the closing `---`) becomes `body`.
 *
 * ## Constraints
 *
 * - **CON-12**: SKILL.md files are limited to ~500 lines. Exceeding this limit
 *   triggers a warning log and the skill is still loaded, but the body is
 *   truncated to the first 500 lines.
 *
 * ## Hot-Reload (CON-04)
 *
 * The `watchForChanges()` method sets up filesystem watchers on both skill
 * directories. File changes are debounced with a 500ms window to coalesce
 * rapid edits (e.g., editor save-then-format). On change, the affected
 * skill is reloaded and the skill registry is updated without restart.
 *
 * @module skills/loader
 */

import type { SkillLoader, SkillDefinition } from '../domain/index.js';

/** Default path for common (shared) skills available to all teams. */
const COMMON_SKILLS_PATH = '/app/common/skills/';

/** Workspace-relative path where team-specific skill overrides live. */
const WORKSPACE_SKILLS_DIR = '.claude/skills/';

/** Maximum number of lines allowed in a SKILL.md file (CON-12). */
const MAX_SKILL_LINES = 500;

/** Debounce interval in milliseconds for hot-reload file watchers (CON-04). */
const WATCH_DEBOUNCE_MS = 500;

// Force usage of constants so TypeScript strict mode does not complain.
void COMMON_SKILLS_PATH;
void WORKSPACE_SKILLS_DIR;
void MAX_SKILL_LINES;
void WATCH_DEBOUNCE_MS;

/**
 * Implementation of the {@link SkillLoader} interface.
 *
 * Discovers SKILL.md files from workspace and common locations, parses YAML
 * frontmatter into {@link SkillDefinition} objects, and supports hot-reload
 * via filesystem watchers with 500ms debounce.
 */
export class SkillLoaderImpl implements SkillLoader {
  /**
   * Loads a single skill by name from the given workspace path.
   *
   * Search order:
   * 1. `<workspacePath>/.claude/skills/<skillName>/SKILL.md`
   * 2. `/app/common/skills/<skillName>/SKILL.md`
   *
   * The workspace copy takes precedence if both exist (team override).
   *
   * Parses the YAML frontmatter for metadata (name, description, argument_hint,
   * allowed_tools, model) and the Markdown body for the skill instructions.
   *
   * @param _workspacePath - Absolute path to the team workspace
   * @param _skillName - Name of the skill to load (directory name)
   * @returns The parsed skill definition
   * @throws {NotFoundError} If no SKILL.md exists in either location
   * @throws {ValidationError} If the YAML frontmatter is malformed
   */
  async loadSkill(_workspacePath: string, _skillName: string): Promise<SkillDefinition> {
    throw new Error('Not implemented');
  }

  /**
   * Loads all skills available to a team workspace.
   *
   * Discovers skills from both locations:
   * - `<workspacePath>/.claude/skills/` — team-specific overrides
   * - `/app/common/skills/` — shared defaults
   *
   * When both contain a skill with the same name, the workspace version
   * wins. Skills exceeding ~500 lines (CON-12) are truncated with a
   * warning log.
   *
   * @param _workspacePath - Absolute path to the team workspace
   * @returns Array of all discovered skill definitions (workspace overrides merged with common)
   */
  async loadAllSkills(_workspacePath: string): Promise<SkillDefinition[]> {
    throw new Error('Not implemented');
  }

  /**
   * Loads all common (shared) skills from `/app/common/skills/`.
   *
   * These skills are available to every team unless overridden by a
   * workspace-local copy. Common skills include built-in capabilities
   * like escalation, health-report, integration-usage, memory-management,
   * system-smoke, and task-completion.
   *
   * @returns Array of common skill definitions
   */
  async loadCommonSkills(): Promise<SkillDefinition[]> {
    throw new Error('Not implemented');
  }

  /**
   * Starts filesystem watchers on skill directories for hot-reload support.
   *
   * Sets up `fs.watch()` on both the workspace skills directory and the
   * common skills directory. File change events are debounced with a 500ms
   * window (CON-04) to coalesce rapid successive edits (e.g., editor
   * save-then-format cycles).
   *
   * When a change is detected after the debounce window:
   * 1. The modified SKILL.md is re-parsed
   * 2. The in-memory skill registry is updated
   * 3. A `skill.reloaded` event is published to the event bus
   *
   * Call `stopWatching()` to clean up watchers on shutdown.
   *
   * @param _workspacePath - Absolute path to the team workspace to watch
   * @returns A cleanup function that stops all watchers
   */
  watchForChanges(_workspacePath: string): () => void {
    throw new Error('Not implemented');
  }
}
