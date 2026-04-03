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
 * Returns {staticRules, dynamicRules} split for prompt cache boundaries.
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
  info(msg: string, meta?: Record<string, unknown>): void;
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

export interface RuleCascadeResult {
  /** Tier 1 (system rules) + Tier 2 (admin org-rules) — stable across teams on same image. */
  readonly staticRules: string;
  /** Tier 3 (ancestor + team org-rules) + Tier 4 (team-only rules) — per-team. */
  readonly dynamicRules: string;
}

export function buildRuleCascade(opts: BuildRuleCascadeOpts): RuleCascadeResult {
  const { teamName, ancestors, runDir, dataDir, systemRulesDir, logger } = opts;

  // ── Static tiers (Tier 1 + Tier 2) ──────────────────────────────────────
  const staticSections: CascadeSection[] = [
    // Tier 1: System rules (baked into Docker image)
    { header: '--- System Rules ---', dirPath: systemRulesDir },
    // Tier 2: Admin org rules (volume mount)
    { header: '--- Organization Rules ---', dirPath: join(dataDir, 'rules') },
  ];

  // ── Dynamic tiers (Tier 3 + Tier 4) ─────────────────────────────────────
  const dynamicSections: CascadeSection[] = [];

  // Tier 3: Ancestor org-rules (root -> parent order, as provided)
  for (const ancestor of ancestors) {
    dynamicSections.push({
      header: `--- Org Rules: ${ancestor} ---`,
      dirPath: join(runDir, 'teams', ancestor, 'org-rules'),
    });
  }

  // Team's own org-rules
  dynamicSections.push({
    header: `--- Org Rules: ${teamName} ---`,
    dirPath: join(runDir, 'teams', teamName, 'org-rules'),
  });

  // Tier 4: Team-only rules (no cascade)
  dynamicSections.push({
    header: `--- Team Rules: ${teamName} ---`,
    dirPath: join(runDir, 'teams', teamName, 'team-rules'),
  });

  const annotated: AnnotatedRule[] = [];

  function buildFromSections(sections: CascadeSection[]): string {
    const parts: string[] = [];
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
    return parts.join('\n');
  }

  const staticRules = buildFromSections(staticSections);
  const dynamicRules = buildFromSections(dynamicSections);

  // Log which rules were loaded (positive observability)
  if (logger) {
    logger.info('Rule cascade loaded', { team: teamName, ruleCount: annotated.length });
  }

  // Validate for conflicts — warn but never throw
  if (logger && annotated.length > 0) {
    const result = validateRuleCascade(annotated);
    for (const warning of result.warnings) {
      logger.warn(warning, { team: teamName });
    }
  }

  return { staticRules, dynamicRules };
}
