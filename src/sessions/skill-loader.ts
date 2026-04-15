/**
 * Skill and subagent loader — reads .md definitions from team directories.
 *
 * Subagent files in subagents/*.md define agent roles and skill references.
 * Skill files in skills/*.md define step-by-step procedures.
 *
 * Skills are appended to the systemPrompt so agents can follow them.
 * Subagent definitions are returned for the SDK `agents` option.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadRulesFromDirectory } from '../rules/loader.js';

/**
 * A subagent definition parsed from a team's subagents/*.md files.
 * Replaces the old claude-agent-sdk AgentDefinition type.
 */
export interface SubagentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly skills?: string[];
  /**
   * Free-form `## Boundaries` section from the subagent markdown — the rules
   * and constraints the subagent must respect (e.g., "never write outside
   * teams/<name>/", "never call the internet"). Present only when the
   * markdown declares a `## Boundaries` section (AC-21).
   */
  readonly boundaries?: string;
  /**
   * Free-form `## Communication Style` section — how the subagent should
   * phrase its responses, e.g. tone, formality, output format. Present only
   * when the markdown declares a `## Communication Style` section (AC-22).
   */
  readonly communicationStyle?: string;
}

interface ParsedSubagent {
  readonly name: string;
  readonly description: string;
  readonly skills: string[];
  readonly boundaries: string;
  readonly communicationStyle: string;
  /**
   * True iff the `## Communication Style` header is present in the file. Used
   * to distinguish "section absent (backward-compat)" from "section present
   * but empty (malformed)" — the latter produces a warning per AC-22.
   */
  readonly hasCommunicationStyleHeader: boolean;
  readonly rawContent: string;
}

/**
 * Parse a subagent .md file into a ParsedSubagent.
 *
 * Expected format:
 *   # Agent: {name}
 *   ## Role
 *   {description}
 *   ## Skills
 *   - {skill-name} — {purpose}
 *   ## Boundaries
 *   {multi-paragraph boundaries until next ## heading}
 */
function parseSubagent(filename: string, content: string): ParsedSubagent {
  const nameMatch = content.match(/^#\s+Agent:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : filename.replace(/\.md$/, '');

  const roleMatch = content.match(/##\s+Role\s*\n([\s\S]*?)(?=\n##|\n$|$)/);
  const description = roleMatch ? roleMatch[1].trim() : '';

  const skillsMatch = content.match(/##\s+Skills\s*\n([\s\S]*?)(?=\n##|\n$|$)/);
  const skills: string[] = [];
  if (skillsMatch) {
    const lines = skillsMatch[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s+(\S+)/);
      if (match) skills.push(match[1]);
    }
  }

  // AC-21: capture the full `## Boundaries` block — including blank lines —
  // up to the next `##` heading so multi-paragraph constraints survive.
  const boundariesMatch = content.match(/##\s+Boundaries\s*\n([\s\S]*?)(?=\n##|\n$|$)/);
  const boundaries = boundariesMatch ? boundariesMatch[1].trim() : '';

  // AC-22: capture the `## Communication Style` block. We track whether the
  // header is present separately from the extracted text so a present-but-
  // empty section can be flagged as malformed (the parser still returns a
  // definition — it never throws — just signals the caller to warn).
  //
  // Two-step parse: an "empty body" (header immediately followed by another
  // `## Heading`) is detected with a dedicated pre-check because the main
  // lookahead `(?=\n##|\n$|$)` — intentionally kept anchored to `\n##` to
  // preserve multi-paragraph bodies — would otherwise greedily absorb the
  // next section when the body is empty.
  const commHeader = /##\s+Communication Style\s*\n/.test(content);
  const commEmptyBody = /##\s+Communication Style\s*\n##/.test(content);
  const commMatch = commEmptyBody
    ? null
    : content.match(/##\s+Communication Style\s*\n([\s\S]*?)(?=\n##|\n$|$)/);
  const communicationStyle = commMatch ? commMatch[1].trim() : '';

  return {
    name,
    description,
    skills,
    boundaries,
    communicationStyle,
    hasCommunicationStyleHeader: commHeader,
    rawContent: content,
  };
}

/**
 * Load all subagent definitions from a team's subagents/ directory.
 *
 * @param runDir    Runtime root (e.g. `.run/`).
 * @param teamName  Team slug.
 * @param warn      Optional callback invoked when a subagent file is
 *                  present but has malformed sections (e.g., an empty
 *                  `## Communication Style` block). The loader NEVER
 *                  throws; missing sections are treated as backward-
 *                  compatible and do not trigger the callback.
 * @returns         Map of subagent name → `SubagentDefinition`.
 */
export function loadSubagents(
  runDir: string,
  teamName: string,
  warn?: (msg: string) => void,
): Record<string, SubagentDefinition> {
  const dir = join(runDir, 'teams', teamName, 'subagents');
  const files = loadRulesFromDirectory(dir);
  const result: Record<string, SubagentDefinition> = {};
  for (const f of files) {
    const def = parseSubagent(f.filename, f.content);
    const entry: { -readonly [K in keyof SubagentDefinition]: SubagentDefinition[K] } = {
      description: def.description,
      prompt: def.rawContent,
      skills: def.skills,
    };
    if (def.boundaries) entry.boundaries = def.boundaries;
    if (def.communicationStyle) entry.communicationStyle = def.communicationStyle;

    // AC-22: malformed = the `## Communication Style` header exists but the
    // extracted body is empty. Surface a clear warning with the filename so
    // authors can fix the file; never throw.
    if (def.hasCommunicationStyleHeader && !def.communicationStyle && warn) {
      warn(`subagent ${f.filename}: "## Communication Style" section is empty`);
    }

    result[def.name] = entry;
  }
  return result;
}

/**
 * Load all skill content from a team's skills/ directory.
 * Returns concatenated skill content for appending to systemPrompt.
 */
export function loadSkillsContent(runDir: string, teamName: string): string {
  const dir = join(runDir, 'teams', teamName, 'skills');
  const files = loadRulesFromDirectory(dir);
  if (files.length === 0) return '';

  const parts = ['--- Skills ---'];
  for (const file of files) {
    parts.push(file.content);
  }
  return parts.join('\n');
}

/**
 * Resolve which skill is active for this task session.
 * Returns the skill file content if a matching skill file exists.
 */
export function resolveActiveSkill(
  runDir: string,
  teamName: string,
  skillName?: string,
  systemRulesDir?: string,
): { name: string; content: string } | null {
  if (!skillName) return null;

  // 1. Try team-level skill first
  const teamPath = join(runDir, 'teams', teamName, 'skills', `${skillName}.md`);
  try {
    const content = readFileSync(teamPath, 'utf-8');
    return { name: skillName, content };
  } catch { /* not found at team level */ }

  // 2. Fall back to system-rules/skills/
  if (systemRulesDir) {
    const systemPath = join(systemRulesDir, 'skills', `${skillName}.md`);
    try {
      const content = readFileSync(systemPath, 'utf-8');
      return { name: skillName, content };
    } catch { /* not found at system level */ }
  }

  return null;
}

/**
 * Parse the ## Required Tools section from a skill's markdown.
 * Returns an array of tool names.
 */
export function parseRequiredTools(skillContent: string): string[] {
  const match = skillContent.match(/## Required Tools\s*\n([\s\S]*?)(?=\n##|\n$|$)/);
  if (!match) return [];
  const lines = match[1].split('\n');
  const tools: string[] = [];
  for (const line of lines) {
    const m = line.match(/^-\s+(\S+)/);
    if (m) tools.push(m[1]);
  }
  return tools;
}

/**
 * Load only the active skill's content for the prompt.
 *
 * **Active-only semantics (AC-20)**: when no skill is selected, this returns
 * an empty string — inactive skill files remain on disk but are never loaded
 * into the prompt. The former `loadSkillsContent` fallback that injected
 * every team skill is intentionally removed. Callers that need to know a
 * requested skill is missing compare their `skillName` against the
 * `activeSkill` result from `resolveActiveSkill` and log a warning there.
 */
export function loadActiveSkillContent(
  activeSkill: { name: string; content: string } | null,
): string {
  if (activeSkill) {
    return `--- Skills ---\n${activeSkill.content}`;
  }
  return '';
}
