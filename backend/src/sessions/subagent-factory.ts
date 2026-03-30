/**
 * Subagent Factory — builds AI SDK ToolLoopAgent instances from SubagentDefinitions.
 *
 * Each subagent becomes a tool that the main agent can invoke.
 * Internally each tool delegates to a ToolLoopAgent with its own
 * system prompt, model, and available tools.
 */

import { ToolLoopAgent, stepCountIs, tool } from 'ai';
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
 * Build a record of tools — one per subagent definition — that the main
 * agent can call to delegate work. Each tool wraps a ToolLoopAgent.
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

    const agent = new ToolLoopAgent({
      model,
      instructions: def.prompt,
      tools: opts.tools,
      stopWhen: stepCountIs(maxSteps),
    });

    result[name] = tool({
      description: def.description,
      inputSchema: z.object({
        task: z.string().describe('The task for this subagent'),
      }),
      execute: async ({ task }, { abortSignal }) => {
        const res = await agent.generate({ prompt: task, abortSignal });
        return res.text;
      },
    });
  }

  return result;
}
