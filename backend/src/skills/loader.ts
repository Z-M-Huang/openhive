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

import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { SkillLoader, SkillDefinition, SkillRegistry } from '../domain/index.js';
import { NotFoundError } from '../domain/index.js';

/** Default path for common (shared) skills available to all teams. */
const DEFAULT_COMMON_SKILLS_PATH = '/app/common/skills';

/** Workspace-relative path where team-specific skill overrides live. */
const WORKSPACE_SKILLS_DIR = '.claude/skills';

/** Maximum number of lines allowed in a SKILL.md body (CON-12). */
const MAX_SKILL_LINES = 500;

/** Debounce interval in milliseconds for hot-reload file watchers (CON-04). */
const WATCH_DEBOUNCE_MS = 500;

/**
 * Parses a SKILL.md file's raw content into a {@link SkillDefinition}.
 *
 * Splits YAML frontmatter (between `---` markers) from the Markdown body.
 * Maps kebab-case YAML keys to camelCase SkillDefinition fields.
 * Truncates body at 500 lines (CON-12).
 */
function parseSkillFile(content: string, skillName: string): SkillDefinition {
  // Split frontmatter from body
  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = fmRegex.exec(content);

  let frontmatter: Record<string, unknown> = {};
  let body: string;

  if (match) {
    frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
    body = match[2];
  } else {
    // No frontmatter — entire content is body
    body = content;
  }

  // CON-12: Truncate body at 500 lines
  const lines = body.split('\n');
  if (lines.length > MAX_SKILL_LINES) {
    body = lines.slice(0, MAX_SKILL_LINES).join('\n');
  }

  const def: SkillDefinition = {
    name: (frontmatter['name'] as string) ?? skillName,
    description: (frontmatter['description'] as string) ?? '',
    body,
  };

  // Map optional fields (support both kebab-case and camelCase/snake_case)
  const argHint = frontmatter['argument-hint'] ?? frontmatter['argument_hint'] ?? frontmatter['argumentHint'];
  if (argHint != null) def.argumentHint = String(argHint);

  const allowedTools = frontmatter['allowed-tools'] ?? frontmatter['allowed_tools'] ?? frontmatter['allowedTools'];
  if (Array.isArray(allowedTools)) def.allowedTools = allowedTools.map(String);

  const model = frontmatter['model'];
  if (model != null) def.model = model as SkillDefinition['model'];

  const context = frontmatter['context'];
  if (context != null) def.context = context as SkillDefinition['context'];

  const agent = frontmatter['agent'];
  if (agent != null) def.agent = String(agent);

  const disableModel = frontmatter['disable-model-invocation'] ?? frontmatter['disableModelInvocation'];
  if (disableModel != null) def.disableModelInvocation = Boolean(disableModel);

  const userInvocable = frontmatter['user-invocable'] ?? frontmatter['userInvocable'];
  if (userInvocable != null) def.userInvocable = Boolean(userInvocable);

  return def;
}

/**
 * Scans a skills directory and returns a map of skill name to SkillDefinition.
 * Expects the directory structure: `<dir>/<skill-name>/SKILL.md`
 */
async function scanSkillsDir(dir: string): Promise<Map<string, SkillDefinition>> {
  const result = new Map<string, SkillDefinition>();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist — no skills
    return result;
  }

  for (const entry of entries) {
    const skillFile = join(dir, entry, 'SKILL.md');
    try {
      await access(skillFile);
      const content = await readFile(skillFile, 'utf-8');
      const def = parseSkillFile(content, entry);
      result.set(def.name, def);
    } catch {
      // Skip entries without a valid SKILL.md
    }
  }

  return result;
}

/**
 * Implementation of the {@link SkillLoader} interface.
 *
 * Discovers SKILL.md files from workspace and common locations, parses YAML
 * frontmatter into {@link SkillDefinition} objects, and supports hot-reload
 * via filesystem watchers with 500ms debounce.
 */
export class SkillLoaderImpl implements SkillLoader {
  private readonly commonSkillsPath: string;
  private readonly registry: SkillRegistry | undefined;

  constructor(opts?: { commonSkillsPath?: string; registry?: SkillRegistry }) {
    this.commonSkillsPath = opts?.commonSkillsPath ?? DEFAULT_COMMON_SKILLS_PATH;
    this.registry = opts?.registry;
  }

  /**
   * Loads a single skill by name from the given workspace path.
   *
   * Search order:
   * 1. `<workspacePath>/.claude/skills/<skillName>/SKILL.md`
   * 2. `<commonSkillsPath>/<skillName>/SKILL.md`
   *
   * The workspace copy takes precedence if both exist (team override).
   *
   * @throws {NotFoundError} If no SKILL.md exists in either location
   */
  async loadSkill(workspacePath: string, skillName: string): Promise<SkillDefinition> {
    // Check workspace first
    const wsFile = join(workspacePath, WORKSPACE_SKILLS_DIR, skillName, 'SKILL.md');
    try {
      await access(wsFile);
      const content = await readFile(wsFile, 'utf-8');
      return parseSkillFile(content, skillName);
    } catch {
      // Not in workspace — fall through to common
    }

    // Check common
    const commonFile = join(this.commonSkillsPath, skillName, 'SKILL.md');
    try {
      await access(commonFile);
      const content = await readFile(commonFile, 'utf-8');
      return parseSkillFile(content, skillName);
    } catch {
      throw new NotFoundError(`Skill '${skillName}' not found in workspace or common skills`);
    }
  }

  /**
   * Loads all skills available to a team workspace.
   *
   * Workspace skills shadow common skills by name (INV-08).
   */
  async loadAllSkills(workspacePath: string): Promise<SkillDefinition[]> {
    const commonSkills = await scanSkillsDir(this.commonSkillsPath);
    const wsSkills = await scanSkillsDir(join(workspacePath, WORKSPACE_SKILLS_DIR));

    // Merge: workspace shadows common
    const merged = new Map(commonSkills);
    for (const [name, skill] of wsSkills) {
      merged.set(name, skill);
    }

    return Array.from(merged.values());
  }

  /**
   * Loads all common (shared) skills from the common skills path.
   */
  async loadCommonSkills(): Promise<SkillDefinition[]> {
    const skills = await scanSkillsDir(this.commonSkillsPath);
    return Array.from(skills.values());
  }

  /**
   * Starts filesystem watchers on the workspace skills directory for hot-reload.
   *
   * File change events are debounced with a 500ms window (CON-04).
   * When a change is detected, the affected skill is reloaded and the
   * registry is updated.
   *
   * @returns A cleanup function that stops all watchers
   */
  watchForChanges(workspacePath: string): () => void {
    const registry = this.registry;
    if (!registry) {
      // No registry to update — return no-op cleanup
      return () => {};
    }

    const wsSkillsDir = join(workspacePath, WORKSPACE_SKILLS_DIR);
    const teamSlug = basename(workspacePath);

    const watchers: FSWatcher[] = [];
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const handleChange = (filePath: string) => {
      // Only care about SKILL.md files
      if (!filePath.endsWith('SKILL.md')) return;

      // Extract skill name from path: .../skills/<name>/SKILL.md
      const skillDir = dirname(filePath);
      const skillName = basename(skillDir);

      // Debounce (CON-04)
      const existing = debounceTimers.get(skillName);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        skillName,
        setTimeout(() => {
          debounceTimers.delete(skillName);
          void (async () => {
            try {
              const content = await readFile(filePath, 'utf-8');
              const def = parseSkillFile(content, skillName);
              registry.register(teamSlug, def);
            } catch {
              // File may have been deleted
              registry.unregister(teamSlug, skillName);
            }
          })();
        }, WATCH_DEBOUNCE_MS),
      );
    };

    const handleUnlink = (filePath: string) => {
      if (!filePath.endsWith('SKILL.md')) return;
      const skillDir = dirname(filePath);
      const skillName = basename(skillDir);

      const existing = debounceTimers.get(skillName);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        skillName,
        setTimeout(() => {
          debounceTimers.delete(skillName);
          registry.unregister(teamSlug, skillName);
        }, WATCH_DEBOUNCE_MS),
      );
    };

    const watcher = chokidarWatch(wsSkillsDir, {
      ignoreInitial: true,
      depth: 2,
    });

    watcher.on('change', handleChange);
    watcher.on('add', handleChange);
    watcher.on('unlink', handleUnlink);

    watchers.push(watcher);

    return () => {
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      for (const w of watchers) {
        void w.close();
      }
    };
  }
}
