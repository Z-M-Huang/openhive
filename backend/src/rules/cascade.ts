/**
 * Rule cascade builder — assembles the full rule cascade for a team.
 *
 * Cascade order (most general to most specific):
 *   1. Global rules:        {dataDir}/rules/global/*.md
 *   2. Main org-rules:      {dataDir}/main/org-rules/*.md
 *   3. Ancestor org-rules:  {dataDir}/teams/{ancestor}/org-rules/*.md (root -> parent)
 *   4. Team org-rules:      {dataDir}/teams/{teamName}/org-rules/*.md
 *   5. Team-only rules:     {dataDir}/teams/{teamName}/team-rules/*.md
 *
 * Returns a single concatenated string with section headers.
 * When a logger is provided, validates the cascade for conflicts and warns.
 */

import { join } from 'node:path';
import { loadRulesFromDirectory } from './loader.js';
import { validateRuleCascade } from './validator.js';
import type { AnnotatedRule } from './validator.js';

interface CascadeSection {
  readonly header: string;
  readonly dirPath: string;
}

export interface CascadeLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export function buildRuleCascade(
  teamName: string,
  ancestors: string[],
  dataDir: string,
  logger?: CascadeLogger,
): string {
  const sections: CascadeSection[] = [
    { header: '--- Global Rules ---', dirPath: join(dataDir, 'rules', 'global') },
    { header: '--- Main Org Rules ---', dirPath: join(dataDir, 'main', 'org-rules') },
  ];

  // Ancestor org-rules (root -> parent order, as provided)
  for (const ancestor of ancestors) {
    sections.push({
      header: `--- Org Rules: ${ancestor} ---`,
      dirPath: join(dataDir, 'teams', ancestor, 'org-rules'),
    });
  }

  // Team's own org-rules
  sections.push({
    header: `--- Org Rules: ${teamName} ---`,
    dirPath: join(dataDir, 'teams', teamName, 'org-rules'),
  });

  // Team-only rules (no cascade)
  sections.push({
    header: `--- Team Rules: ${teamName} ---`,
    dirPath: join(dataDir, 'teams', teamName, 'team-rules'),
  });

  const parts: string[] = [];
  const annotated: AnnotatedRule[] = [];

  for (const section of sections) {
    const rules = loadRulesFromDirectory(section.dirPath);
    if (rules.length === 0) continue;

    parts.push(section.header);
    for (const rule of rules) {
      parts.push(rule.content);
      annotated.push({
        filename: rule.filename,
        content: rule.content,
        source: section.header,
      });
    }
  }

  // Validate for conflicts — warn but never throw
  if (logger && annotated.length > 0) {
    const result = validateRuleCascade(annotated);
    for (const warning of result.warnings) {
      logger.warn(warning, { team: teamName });
    }
  }

  return parts.join('\n');
}
