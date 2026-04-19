/**
 * Skill-loading tool — `use_skill(skill_name)` returns the full body of a
 * declared skill so the subagent can follow its steps. Registered into the
 * subagent toolset by `tool-assembler.ts` and `subagent-factory.ts` whenever
 * the active subagent has at least one resolved skill.
 *
 * On success, returns `{body}` with no envelope so the LLM doesn't treat
 * extra metadata as authoritative content. Bare plugin-tool references in
 * the body (e.g. `fetch_loggly_logs`) are rewritten to their registered
 * namespaced form (`<teamName>.<toolName>`) so the LLM finds matching
 * tools in its toolset — skill bodies are LLM-authored and commonly omit
 * the team prefix even though plugins are registered namespaced.
 *
 * On failure, returns `{error}` with the available skill names to help
 * the LLM self-correct.
 */

import { z } from 'zod';
import { tool } from 'ai';
import type { SubagentDefinition } from '../skill-loader.js';
import { namespacePluginRefs } from '../subagent-prompt.js';

export const useSkillInputSchema = z.object({
  skill_name: z.string().describe('The name of the skill to load (must match one of your declared skills).'),
});

export function buildUseSkillTool(subagentDef: SubagentDefinition, teamName: string) {
  return {
    use_skill: tool({
      description: 'Load the full step-by-step procedure for one of your declared skills. Returns the skill body so you can follow its steps. ALWAYS call this BEFORE attempting the work yourself if a matching skill exists.',
      inputSchema: useSkillInputSchema,
      execute: async ({ skill_name }: z.infer<typeof useSkillInputSchema>) => {
        const skills = subagentDef.resolvedSkills ?? [];
        const found = skills.find((s) => s.name === skill_name);
        if (!found) {
          const available = skills.map((s) => s.name).join(', ');
          return {
            error: `skill "${skill_name}" not declared on this subagent. Available: ${available || '(none)'}`,
          };
        }
        return { body: namespacePluginRefs(found.content, teamName, found.requiredTools) };
      },
    }),
  };
}
