/**
 * Rule cascade builder — assembles the full rule cascade for a team.
 *
 * Four-level cascade (most general to most specific):
 *   1. System rules:       {systemRulesDir}/*.md (baked into image, immutable)
 *   2. Admin org rules:    {dataDir}/rules/*.md (admin-managed, shared)
 *   3. Ancestor org-rules: {runDir}/teams/{ancestor}/org-rules/*.md (root → parent)
 *      + Team org-rules:   {runDir}/teams/{teamName}/org-rules/*.md
 *   4. Team-only rules:    {runDir}/teams/{teamName}/team-rules/*.md
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

export interface BuildRuleCascadeOpts {
  readonly teamName: string;
  readonly ancestors: string[];
  readonly runDir: string;
  readonly dataDir: string;
  readonly systemRulesDir: string;
  readonly logger?: CascadeLogger;
}

export function buildRuleCascade(opts: BuildRuleCascadeOpts): string {
  const { teamName, ancestors, runDir, dataDir, systemRulesDir, logger } = opts;

  const sections: CascadeSection[] = [
    // Tier 1: System rules (baked into Docker image)
    { header: '--- System Rules ---', dirPath: systemRulesDir },
    // Tier 2: Admin org rules (volume mount)
    { header: '--- Organization Rules ---', dirPath: join(dataDir, 'rules') },
  ];

  // Tier 3: Ancestor org-rules (root -> parent order, as provided)
  for (const ancestor of ancestors) {
    sections.push({
      header: `--- Org Rules: ${ancestor} ---`,
      dirPath: join(runDir, 'teams', ancestor, 'org-rules'),
    });
  }

  // Team's own org-rules
  sections.push({
    header: `--- Org Rules: ${teamName} ---`,
    dirPath: join(runDir, 'teams', teamName, 'org-rules'),
  });

  // Tier 4: Team-only rules (no cascade)
  sections.push({
    header: `--- Team Rules: ${teamName} ---`,
    dirPath: join(runDir, 'teams', teamName, 'team-rules'),
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
