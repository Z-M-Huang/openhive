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
}

interface ParsedSubagent {
  readonly name: string;
  readonly description: string;
  readonly skills: string[];
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

  return { name, description, skills, rawContent: content };
}

/**
 * Load all subagent definitions from a team's subagents/ directory.
 * Returns Record<string, SubagentDefinition>.
 */
export function loadSubagents(runDir: string, teamName: string): Record<string, SubagentDefinition> {
  const dir = join(runDir, 'teams', teamName, 'subagents');
  const files = loadRulesFromDirectory(dir);
  const result: Record<string, SubagentDefinition> = {};
  for (const f of files) {
    const def = parseSubagent(f.filename, f.content);
    result[def.name] = { description: def.description, prompt: def.rawContent, skills: def.skills };
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
 * Falls back to loadSkillsContent() if no specific skill is active.
 */
export function loadActiveSkillContent(
  runDir: string,
  teamName: string,
  activeSkill: { name: string; content: string } | null,
): string {
  if (activeSkill) {
    return `--- Skills ---\n${activeSkill.content}`;
  }
  return loadSkillsContent(runDir, teamName);
}
