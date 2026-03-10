/**
 * OpenHive Backend - SkillLoader
 *
 * Loads skill definitions from the workspace's .claude/skills/ directory.
 * Each skill lives in its own subdirectory: .claude/skills/<name>/SKILL.md
 *
 * No HTTP fetching — local files only.
 */

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Skill } from '../domain/types.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { parseModelTier } from '../domain/enums.js';

// ---------------------------------------------------------------------------
// Logger interface — minimal structured logger required by SkillLoader
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger interface required by SkillLoader.
 * Compatible with pino or any standard structured logger.
 */
export interface SkillLoaderLogger {
  warn(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// SkillLoader
// ---------------------------------------------------------------------------

/**
 * Loads skill definitions from a team workspace's .claude/skills/ directory.
 *
 * Skill files are stored under:
 *   <workspaceBase>/.claude/skills/<name>/SKILL.md
 *
 * The workspaceBase is the root of a team's workspace directory
 * (e.g. .run/workspace/teams/<slug>/ or .run/workspace/ for main).
 */
export class SkillLoader {
  private readonly workspaceBase: string;
  private readonly logger: SkillLoaderLogger;

  constructor(workspaceBase: string, logger: SkillLoaderLogger) {
    this.workspaceBase = workspaceBase;
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // loadSkill
  // -------------------------------------------------------------------------

  /**
   * Loads a single skill by name from the workspace's .claude/skills/ directory.
   *
   * Reads: <workspaceBase>/.claude/skills/<skillName>/SKILL.md
   *
   * skillName must not contain path separators or traversal components.
   *
   * Throws:
   *   - ValidationError if skillName is invalid
   *   - NotFoundError if the skill directory or SKILL.md does not exist
   *   - Error if the skill file cannot be parsed or fails validation
   */
  loadSkill(skillName: string): Skill {
    validateSkillName(skillName);

    const skillFile = join(this.workspaceBase, '.claude', 'skills', skillName, 'SKILL.md');

    let data: Buffer;
    try {
      data = readFileSync(skillFile);
    } catch (err) {
      if (isEnoent(err)) {
        throw new NotFoundError('skill', skillName);
      }
      throw err;
    }

    let skill: Skill;
    try {
      skill = parseSkillMarkdown(data.toString('utf8'));
    } catch (err) {
      throw new Error(
        `failed to parse skill ${skillName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!skill.name || skill.name === '') {
      skill = { ...skill, name: skillName };
    }

    validateSkill(skill);

    return skill;
  }

  // -------------------------------------------------------------------------
  // loadAllSkills
  // -------------------------------------------------------------------------

  /**
   * Loads all skills from the workspace's .claude/skills/ directory.
   *
   * Each skill is expected in its own subdirectory: .claude/skills/<name>/SKILL.md
   *
   * Returns an empty array if the skills directory does not exist.
   * Logs and skips any skill that fails to load.
   *
   * Throws:
   *   - Error if the skills directory cannot be read (other than ENOENT)
   */
  loadAllSkills(): Skill[] {
    const skillsDir = join(this.workspaceBase, '.claude', 'skills');

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true }) as Dirent<string>[];
    } catch (err) {
      if (isEnoent(err)) {
        return [];
      }
      throw new Error(
        `failed to read skills directory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const skills: Skill[] = [];

    for (const entry of entries) {
      // Only process directories — each skill lives in its own subdirectory.
      if (!entry.isDirectory()) {
        continue;
      }

      const skillName = entry.name;

      try {
        validateSkillName(skillName);
      } catch (err) {
        this.logger.warn('skipping skill directory with invalid base name', {
          dir: skillName,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      let skill: Skill;
      try {
        skill = this.loadSkill(skillName);
      } catch (err) {
        this.logger.warn('failed to load skill', {
          skill: skillName,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      skills.push(skill);
    }

    return skills;
  }
}

// ---------------------------------------------------------------------------
// validateSkill
// ---------------------------------------------------------------------------

/**
 * Validates a skill definition.
 *
 * Throws ValidationError if any field is invalid.
 */
export function validateSkill(skill: Skill): void {
  if (!skill.name || skill.name === '') {
    throw new ValidationError('name', 'skill name is required');
  }

  validateSkillName(skill.name);

  if (skill.model_tier !== undefined && skill.model_tier !== '') {
    try {
      parseModelTier(skill.model_tier);
    } catch {
      throw new ValidationError(
        'model_tier',
        `invalid model_tier: ${skill.model_tier} (must be haiku, sonnet, or opus)`,
      );
    }
  }

  if (skill.tools !== undefined) {
    for (const toolName of skill.tools) {
      try {
        validateToolName(toolName);
      } catch (err) {
        throw new ValidationError(
          'tools',
          `invalid tool name ${JSON.stringify(toolName)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// validateSkillName (internal)
// ---------------------------------------------------------------------------

/**
 * Validates that a skill name is safe and well-formed.
 *
 * Rejects empty strings, path traversal components, path separators,
 * and characters outside [a-zA-Z0-9_-].
 *
 * Throws ValidationError if invalid.
 */
export function validateSkillName(name: string): void {
  if (name === '') {
    throw new ValidationError('skill_name', 'skill name cannot be empty');
  }
  if (name.includes('..')) {
    throw new ValidationError('skill_name', "skill name must not contain '..' (path traversal)");
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new ValidationError('skill_name', 'skill name must not contain path separators');
  }
  for (const c of name) {
    const cp = c.codePointAt(0)!;
    const isLower = cp >= 97 && cp <= 122; // a-z
    const isUpper = cp >= 65 && cp <= 90; // A-Z
    const isDigit = cp >= 48 && cp <= 57; // 0-9
    const isHyphen = c === '-';
    const isUnderscore = c === '_';
    if (!isLower && !isUpper && !isDigit && !isHyphen && !isUnderscore) {
      throw new ValidationError(
        'skill_name',
        `skill name contains invalid character: ${JSON.stringify(c)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// validateToolName (internal)
// ---------------------------------------------------------------------------

/**
 * Validates that a tool name contains only alphanumerics and underscores.
 *
 * Throws an Error (not ValidationError) if invalid — the caller
 * (validateSkill) wraps it into a ValidationError.
 */
function validateToolName(name: string): void {
  if (name === '') {
    throw new Error('tool name cannot be empty');
  }
  for (const c of name) {
    const cp = c.codePointAt(0)!;
    const isLower = cp >= 97 && cp <= 122; // a-z
    const isUpper = cp >= 65 && cp <= 90; // A-Z
    const isDigit = cp >= 48 && cp <= 57; // 0-9
    const isUnderscore = c === '_';
    if (!isLower && !isUpper && !isDigit && !isUnderscore) {
      throw new Error(`tool name ${JSON.stringify(name)} contains invalid character ${JSON.stringify(c)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// parseSkillMarkdown (internal)
// ---------------------------------------------------------------------------

/**
 * Parses a SKILL.md file.
 *
 * If the file starts with a YAML front-matter block (--- ... ---), parses
 * the front-matter as YAML into a Skill and uses the remaining body as
 * system_prompt_addition. If no front-matter is present, the entire content
 * becomes system_prompt_addition.
 *
 * Uses CORE_SCHEMA for safe YAML parsing (no implicit type coercions).
 */
function parseSkillMarkdown(content: string): Skill {
  const trimmed = content.trimStart();

  if (trimmed.startsWith('---')) {
    const rest = trimmed.slice(3); // skip opening '---'
    const idx = rest.indexOf('\n---');
    if (idx >= 0) {
      const frontmatter = rest.slice(0, idx);
      const body = rest.slice(idx + 4).trimStart(); // skip '\n---'

      let parsed: unknown;
      try {
        parsed = parseYaml(frontmatter, { schema: 'core' });
      } catch (err) {
        throw new Error(
          `frontmatter parse error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const skill = coerceToSkill(parsed);
      skill.system_prompt_addition = body;
      return skill;
    }
  }

  // No front-matter — entire content is the system prompt addition.
  return {
    name: '',
    system_prompt_addition: trimmed,
  };
}

// ---------------------------------------------------------------------------
// coerceToSkill (internal)
// ---------------------------------------------------------------------------

/**
 * Coerces an unknown parsed value to a Skill.
 *
 * Validates that the parsed value is a plain object and extracts all known
 * Skill fields with their expected types. Unknown fields are silently ignored.
 *
 * Throws an Error if the parsed value is not a plain object.
 */
function coerceToSkill(parsed: unknown): Skill {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('skill file must contain a mapping object at the top level');
  }

  const obj = parsed as Record<string, unknown>;

  const skill: Skill = {
    name: typeof obj['name'] === 'string' ? obj['name'] : '',
  };

  if (typeof obj['description'] === 'string') {
    skill.description = obj['description'];
  }
  if (typeof obj['model_tier'] === 'string') {
    skill.model_tier = obj['model_tier'];
  }
  if (Array.isArray(obj['tools'])) {
    skill.tools = obj['tools'].filter((t): t is string => typeof t === 'string');
  }
  if (typeof obj['system_prompt_addition'] === 'string') {
    skill.system_prompt_addition = obj['system_prompt_addition'];
  }

  return skill;
}

// ---------------------------------------------------------------------------
// isEnoent (internal)
// ---------------------------------------------------------------------------

/**
 * Returns true if the given error represents a file-not-found (ENOENT) condition.
 */
function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
