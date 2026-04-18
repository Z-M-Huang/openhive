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
 *
 * AC-11: Plugin tools from resolvedSkills are loaded per-invocation inside
 * each subagent's execute() and merged into the tool set.
 * AC-12: Default maxSteps is 100 (not 10); callers may override via opts.maxSteps.
 */

import { generateText, stepCountIs, tool } from 'ai';
import type { ToolSet, LanguageModel } from 'ai';
import { z } from 'zod';
import type { SubagentDefinition } from './skill-loader.js';
import type { ProviderRegistryProvider } from './provider-registry.js';
import { loadPluginTools } from './tools/plugin-loader.js';
import type { IPluginToolStore } from '../domain/interfaces.js';

export interface BuildSubagentToolsOpts {
  // ── New interface fields (AC-11, AC-12) ────────────────────────────────────
  /**
   * New-style subagent definitions keyed by agent name.
   * Takes precedence over subagentDefs when both are provided.
   */
  subagents?: Record<string, {
    name?: string;
    description?: string;
    prompt: string;
    resolvedSkills?: readonly {
      name: string;
      content: string;
      requiredTools: readonly string[];
    }[];
  }>;
  /** Team name used for namespacing plugin tools (required when pluginToolStore is set). */
  teamName?: string;
  /** Allowed tool name patterns (supports '*' wildcard). */
  allowedTools?: readonly string[];
  /** Plugin tool store for per-invocation plugin loading. */
  pluginToolStore?: IPluginToolStore;
  /** Filesystem root for locating plugin source files. */
  runDir?: string;
  /** Language model instance (new interface). Falls back to registry resolution. */
  model?: LanguageModel;

  // ── Legacy interface fields (backward compat) ───────────────────────────────
  registry?: ProviderRegistryProvider;
  profileName?: string;
  modelId?: string;
  /** Legacy subagent definitions. Prefer subagents for new code. */
  subagentDefs?: Record<string, SubagentDefinition>;

  // ── Shared fields ───────────────────────────────────────────────────────────
  /** Base tools available to all subagents (before plugin merge). */
  tools?: ToolSet;
  /** Max tool-loop steps per subagent invocation (default 100). */
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
 * the subagent's system prompt, the shared tool set plus per-invocation
 * plugin tools from resolvedSkills, and a step-count stop condition.
 *
 * Supports both the new interface (subagents + model + teamName + pluginToolStore)
 * and the legacy interface (subagentDefs + registry + profileName + modelId).
 */
export async function buildSubagentTools(
  opts: BuildSubagentToolsOpts,
): Promise<ToolSet> {
  const result: ToolSet = {};
  // Support both new (subagents) and legacy (subagentDefs) interfaces.
  type DefShape = {
    description?: string;
    prompt: string;
    resolvedSkills?: readonly {
      name: string;
      content: string;
      requiredTools: readonly string[];
    }[];
  };
  const subagents: Record<string, DefShape> = (opts.subagents ?? opts.subagentDefs ?? {}) as Record<string, DefShape>;

  for (const [name, def] of Object.entries(subagents)) {
    // Model: new interface supplies opts.model; legacy resolves from registry.
    // Cast: opts.profileName/modelId may be `string | undefined`; the registry
    // expects `\`${string}:${string}\`` so we assert the template literal type.
    const model = opts.model ?? opts.registry?.languageModel(
      `${opts.profileName}:${opts.modelId}` as `${string}:${string}`,
    );
    // Precompute stop condition once per subagent definition; `stepCountIs` is a
    // pure factory — no benefit to recreating it on every execute() invocation.
    const stopWhen = stepCountIs(opts.maxSteps ?? 100);

    result[name] = tool({
      description: def.description ?? `Delegate task to ${name}`,
      inputSchema: z.object({
        task: z.string().describe('The task for this subagent'),
      }),
      execute: async ({ task }, { abortSignal }): Promise<SubagentToolResult> => {
        // Per-invocation plugin load from resolvedSkills (AC-11).
        // Only runs when all three fields are provided; no-op otherwise.
        const skillTools: ToolSet = {};
        if (opts.pluginToolStore && opts.teamName && opts.runDir) {
          for (const s of def.resolvedSkills ?? []) {
            const loaded = await loadPluginTools(
              opts.teamName,
              s.requiredTools as string[],
              opts.allowedTools ?? [],
              opts.pluginToolStore,
              opts.runDir,
            );
            Object.assign(skillTools, loaded);
          }
        }
        // Preserve opts.tools reference when no plugin tools are added, so
        // callers using strict reference equality checks (e.g. tests with toBe)
        // continue to pass.
        const toolsForInvocation: ToolSet =
          Object.keys(skillTools).length === 0
            ? (opts.tools ?? {})
            : { ...(opts.tools ?? {}), ...skillTools };

        const res = await generateText({
          model: model as LanguageModel,
          system: def.prompt,
          prompt: task,
          tools: toolsForInvocation,
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
