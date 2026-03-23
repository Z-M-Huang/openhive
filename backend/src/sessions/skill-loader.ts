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
import { loadRulesFromDirectory } from '../rules/loader.js';

export interface SubagentDef {
  readonly name: string;
  readonly description: string;
  readonly skills: string[];
  readonly rawContent: string;
}

/**
 * Parse a subagent .md file into a SubagentDef.
 *
 * Expected format:
 *   # Agent: {name}
 *   ## Role
 *   {description}
 *   ## Skills
 *   - {skill-name} — {purpose}
 */
function parseSubagent(filename: string, content: string): SubagentDef {
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
 */
export function loadSubagents(runDir: string, teamName: string): SubagentDef[] {
  const dir = join(runDir, 'teams', teamName, 'subagents');
  const files = loadRulesFromDirectory(dir);
  return files.map(f => parseSubagent(f.filename, f.content));
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
