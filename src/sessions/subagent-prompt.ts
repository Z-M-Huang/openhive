/**
 * Shared subagent-identity prompt helper.
 *
 * `formatSubagentIdentity` builds the per-session system block injected when
 * a task is run as a named subagent. Two code paths consume it:
 *   - `message-handler.ts` — Fix 4 in-place subagent path.
 *   - `subagent-factory.ts` — legacy delegated `delegate_to_<subagent>` tool.
 *
 * Skill delivery is hybrid:
 *   - 0 skills: directive only.
 *   - 1 skill : eager-inline body (no extra tool call needed).
 *   - ≥2      : lazy catalog of `name — description`; subagent fetches each
 *               body on demand via the `use_skill` tool.
 *
 * The directive ("rules 1-5") routes the LLM through skill → namespaced plugin
 * → generic tool, neutralising the description-quality gap that lets LLMs
 * default to `web_fetch` over a 5-word plugin description.
 */

import type { SubagentDefinition } from './skill-loader.js';

/**
 * Rewrite standalone references to a skill's required tools so they match the
 * namespaced form actually loaded into the toolset (`<teamName>.<tool>`).
 * Used by both the eager-inline path (`formatSubagentIdentity` below) and the
 * lazy `use_skill` path (`buildUseSkillTool`). LLM-authored skill bodies
 * routinely omit the team prefix, so without this rewrite the model can't
 * find the matching tool and falls back to `web_fetch`/`Bash`.
 *
 * Lookbehind `(?<![.\w])` blocks an already-namespaced token (`team.tool`) or a
 * substring of a longer identifier (`my_tool_helper`); lookahead `(?![\w])`
 * blocks the tail-end identifier case.
 */
export function namespacePluginRefs(
  body: string,
  teamName: string,
  requiredTools: readonly string[],
): string {
  let out = body;
  for (const t of requiredTools) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![.\\w])${escaped}(?![\\w])`, 'g');
    out = out.replace(re, `${teamName}.${t}`);
  }
  return out;
}

export const DEFAULT_SUBAGENT_DIRECTIVE = [
  '--- Subagent Default Behavior ---',
  'You are running as a named subagent, not the team orchestrator. Standing rules:',
  '1. If a declared skill matches the task, your FIRST tool call MUST be `use_skill("<name>")` (or follow the embedded skill body below) — do NOT call `web_fetch`, `Bash`, or any HTTP tool before loading the skill.',
  '2. Skills wire your team\'s plugin tools together; follow the steps in the skill body verbatim.',
  '3. Prefer your team\'s namespaced plugin tools (`<team>.<tool>`) over generic alternatives like `web_fetch` or `Bash` — your team registered the plugin for a reason.',
  '4. Stay strictly within the constraints declared in your `## Boundaries` section.',
  '5. Only fall back to generic tools (web_fetch, Bash) when no skill applies AND no plugin tool covers the need.',
].join('\n');

export function formatSubagentIdentity(
  name: string,
  def: SubagentDefinition,
  teamName?: string,
): string {
  const parts: string[] = [
    `--- Active Subagent: ${name} ---`,
    def.prompt,
    DEFAULT_SUBAGENT_DIRECTIVE,
  ];
  const skills = def.resolvedSkills ?? [];
  if (skills.length === 1) {
    // Eager: inline the only skill body — fastest, no extra round-trip.
    // Apply same body-rewrite as `use_skill` so bare plugin refs match the
    // namespaced form actually loaded into the toolset. Skipped when
    // teamName is absent (legacy delegated path with no namespace prefix);
    // in that mode no plugin tools are loaded either, so the rewrite would
    // be a no-op anyway.
    const s = skills[0];
    const body = teamName ? namespacePluginRefs(s.content, teamName, s.requiredTools) : s.content;
    parts.push(`--- Active Skill: ${s.name} ---`, body);
  } else if (skills.length >= 2) {
    // Lazy catalog: name + author-written description from `## Skills` bullet.
    parts.push('--- Available Skills (call `use_skill("<name>")` to load procedure) ---');
    for (const s of skills) {
      const oneLiner = def.skillDescriptions?.[s.name] ?? '(no description)';
      parts.push(`- ${s.name} — ${oneLiner}`);
    }
  }
  return parts.join('\n');
}
