/**
 * Inline search_skill_repository tool — searches the skill repository for
 * reusable skill templates.
 *
 * Follows the web-fetch-tool.ts pattern:
 * - SSRF protection via url-validator
 * - 10s timeout via AbortController
 * - 512KB response body cap
 * - Graceful degradation: NEVER throws, returns { results: [], fallback: true }
 * - withAudit wrapping applied centrally in tool-assembler.ts (NOT here)
 */

import { z } from 'zod';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { validateBrowserUrl } from './url-validator.js';
import { safeJsonParse } from '../../domain/safe-json.js';

const SKILL_REPO_URL = 'https://api.skills.sh/v1/search';
const TIMEOUT_MS = 10_000;
const MAX_BODY = 512 * 1024; // 512KB

const SkillSearchInputSchema = z.object({
  query: z.string().describe('Search query describing the skill needed'),
  category: z.string().optional().describe('Optional category filter'),
  minScore: z.number().min(0).max(1).optional().describe('Minimum match score (0-1)'),
});

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Build the search_skill_repository tool as an AI SDK inline tool definition.
 * Returns a ToolSet with a single `search_skill_repository` key.
 */
export function buildSkillRepoTools(): ToolSet {
  const execute = async (input: z.infer<typeof SkillSearchInputSchema>): Promise<unknown> => {
    try {
      // SSRF defense-in-depth (hardcoded URL, but validate pattern)
      const validation = validateBrowserUrl(SKILL_REPO_URL);
      if (!validation.allowed) {
        return { results: [], fallback: true, reason: validation.reason ?? 'URL not allowed' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const res = await fetch(SKILL_REPO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: input.query, category: input.category }),
          signal: controller.signal,
        });

        if (!res.ok) {
          return { results: [], fallback: true, reason: `HTTP ${res.status}` };
        }

        const text = await res.text();
        if (text.length > MAX_BODY) {
          return { results: [], fallback: true, reason: 'Response too large' };
        }

        const data = safeJsonParse<{ results?: Array<Record<string, unknown>> }>(text, 'skill-repo-search');
        if (!data) {
          return { results: [], fallback: true, reason: 'Invalid JSON response' };
        }

        const threshold = input.minScore ?? 0.6;
        const results = (data.results ?? [])
          .filter((r) => typeof r.matchScore === 'number' && r.matchScore >= threshold)
          .map((r) => ({
            name: r.name,
            description: r.description,
            matchScore: r.matchScore,
            installCount: r.installCount,
            sourceReputation: r.sourceReputation,
          }));

        return { results, fallback: false };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Graceful degradation — NEVER throw
      return { results: [], fallback: true, reason: 'Service unavailable' };
    }
  };

  return {
    search_skill_repository: tool({
      description: 'Search the skill repository for reusable skill templates. Returns matches with trust signals (matchScore, installCount, sourceReputation).',
      inputSchema: SkillSearchInputSchema,
      execute,
    }),
  };
}
