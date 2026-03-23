/**
 * Rule conflict validator — detects same-topic rules at different cascade levels.
 *
 * Topic extraction: first markdown heading (# heading) in each rule file.
 * If same topic at different levels and no [OVERRIDE] prefix, report conflict.
 */

export interface AnnotatedRule {
  readonly filename: string;
  readonly content: string;
  readonly source: string;
}

export interface RuleConflict {
  readonly topic: string;
  readonly sources: string[];
  readonly hasOverride: boolean;
}

export interface ValidationResult {
  readonly conflicts: RuleConflict[];
  readonly warnings: string[];
}

function extractTopic(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}

function hasOverrideMarker(content: string): boolean {
  return content.includes('[OVERRIDE]');
}

export function validateRuleCascade(rules: AnnotatedRule[]): ValidationResult {
  // Group rules by topic
  const topicMap = new Map<string, AnnotatedRule[]>();

  for (const rule of rules) {
    const topic = extractTopic(rule.content);
    if (!topic) continue;

    const existing = topicMap.get(topic);
    if (existing) {
      existing.push(rule);
    } else {
      topicMap.set(topic, [rule]);
    }
  }

  const conflicts: RuleConflict[] = [];
  const warnings: string[] = [];

  for (const [topic, entries] of topicMap) {
    if (entries.length < 2) continue;

    // Check if any entry has [OVERRIDE]
    const override = entries.some((e) => hasOverrideMarker(e.content));

    const sources = entries.map((e) => e.source);
    conflicts.push({ topic, sources, hasOverride: override });

    if (!override) {
      warnings.push(
        `Conflicting rules for topic "${topic}" at levels: ${sources.join(', ')}`,
      );
    }
  }

  return { conflicts, warnings };
}
