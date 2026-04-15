/**
 * Subagent Factory — builds AI SDK tools that execute subagents via `generateText`.
 *
 * Each subagent from `SubagentDefinition` becomes a tool the main agent
 * (or team orchestrator) can invoke. When the tool is called, we run
 * `generateText()` bound to the subagent's system prompt, the provided
 * tool set, and a step cap. The tool returns a structured, traceable
 * envelope — `{ subagent, text, steps }` — instead of a bare string
 * so callers can log, audit, and surface step counts without regex
 * parsing the model output.
 *
 * Per AC-23 / ADR-40 subagents are plain `generateText` calls that stop
 * on step count — no separate agent-loop wrapper class is used.
 */

import { generateText, stepCountIs, tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { SubagentDefinition } from './skill-loader.js';
import type { ProviderRegistryProvider } from './provider-registry.js';

/** Maximum number of tool-loop steps a subagent may take. */
const DEFAULT_MAX_STEPS = 10;

export interface BuildSubagentToolsOpts {
  registry: ProviderRegistryProvider;
  profileName: string;
  modelId: string;
  subagentDefs: Record<string, SubagentDefinition>;
  /** Tools available to the subagents. */
  tools: ToolSet;
  /** Max tool-loop steps per subagent invocation (default 10). */
  maxSteps?: number;
}

/**
 * Structured subagent result surfaced to the orchestrator. Keeping the
 * subagent name on the envelope makes traces unambiguous when a single
 * message triggers multiple delegations.
 */
export interface SubagentToolResult {
  readonly subagent: string;
  readonly text: string;
  readonly steps: number;
}

/**
 * Build a record of tools — one per subagent definition — that the main
 * agent can call to delegate work. Each tool runs `generateText()` with
 * the subagent's system prompt, the shared tool set, and a step-count
 * stop condition.
 */
export function buildSubagentTools(
  opts: BuildSubagentToolsOpts,
): ToolSet {
  const result: ToolSet = {};
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  for (const [name, def] of Object.entries(opts.subagentDefs)) {
    const model = opts.registry.languageModel(
      `${opts.profileName}:${opts.modelId}`,
    );
    // Precompute the stop condition once per subagent; `stepCountIs` is a
    // pure factory over a constant `maxSteps`, so recomputing on every
    // invocation would be wasted allocation.
    const stopWhen = stepCountIs(maxSteps);

    result[name] = tool({
      description: def.description,
      inputSchema: z.object({
        task: z.string().describe('The task for this subagent'),
      }),
      execute: async ({ task }, { abortSignal }): Promise<SubagentToolResult> => {
        const res = await generateText({
          model,
          system: def.prompt,
          prompt: task,
          tools: opts.tools,
          stopWhen,
          abortSignal,
        });
        return {
          subagent: name,
          text: res.text,
          steps: Array.isArray(res.steps) ? res.steps.length : 0,
        };
      },
    });
  }

  return result;
}
