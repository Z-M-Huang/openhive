/**
 * Plugin tool loader — loads plugin tools from the filesystem with namespace isolation.
 *
 * Each plugin tool is namespaced as `teamName.toolName` to prevent collisions.
 * Tools are only loaded if they are registered in the plugin tool store with
 * status 'active', pass the allowed_tools filter, and exist on disk.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tool, type ToolSet } from 'ai';
import type { IPluginToolStore } from '../../domain/interfaces.js';
import { errorMessage } from '../../domain/errors.js';

export const RESERVED_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'bash'];

export interface PluginLoaderLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * `{name, description}` pair for one loaded plugin tool. Surfaced so the
 * prompt-builder can list the namespaced tools under the ADR-39 plugin
 * section and downgrade `web_fetch`'s "preferred" wording (Fix 4.5).
 */
export interface LoadedPluginInfo {
  readonly name: string;
  readonly description: string;
}

export interface LoadedPluginTools {
  readonly tools: ToolSet;
  readonly infos: readonly LoadedPluginInfo[];
}

/**
 * Best-effort description extraction. Used when the plugin uses the legacy
 * default-export form (where description is buried in the AI SDK Tool
 * wrapper) or a named-export matching the tool name. Falls back to a generic
 * "Plugin tool …" string when introspection isn't possible.
 */
function extractDescription(
  mod: Record<string, unknown>,
  toolName: string,
  toolValue: unknown,
): string {
  if (typeof mod['description'] === 'string') return mod['description'];
  // AI SDK `Tool` objects expose `description` on the wrapper.
  const t = toolValue as { description?: unknown } | undefined;
  if (t && typeof t.description === 'string') return t.description;
  return `Plugin tool ${toolName} (no description)`;
}

export async function loadPluginTools(
  teamName: string,
  requiredTools: string[],
  allowedTools: readonly string[],
  pluginToolStore: IPluginToolStore,
  runDir: string,
  logger?: PluginLoaderLogger,
): Promise<LoadedPluginTools> {
  const tools: ToolSet = {};
  const infos: LoadedPluginInfo[] = [];

  for (const toolName of requiredTools) {
    if (RESERVED_TOOL_NAMES.includes(toolName.toLowerCase())) continue;

    const meta = pluginToolStore.get(teamName, toolName);
    if (!meta || meta.status !== 'active') continue;

    const toolPath = join(runDir, 'teams', teamName, 'plugins', `${toolName}.ts`);
    if (!existsSync(toolPath)) continue;

    // Check allowed_tools filter
    const namespacedName = `${teamName}.${toolName}`;
    const isAllowed = allowedTools.some(pattern => {
      if (pattern === '*') return true;
      if (pattern === namespacedName) return true;
      if (pattern.endsWith('*') && namespacedName.startsWith(pattern.slice(0, -1))) return true;
      return false;
    });
    if (!isAllowed) continue;

    try {
      const mod = await import(toolPath) as Record<string, unknown>;

      // Try legacy default export first
      const toolDef = mod['default'] as ToolSet[string] | undefined;
      if (toolDef) {
        tools[namespacedName] = toolDef;
        infos.push({ name: namespacedName, description: extractDescription(mod, toolName, toolDef) });
        continue;
      }

      // Try named-export format: description + inputSchema + execute
      if (
        typeof mod['description'] === 'string' &&
        mod['inputSchema'] !== undefined &&
        typeof mod['execute'] === 'function'
      ) {
        tools[namespacedName] = tool({
          description: mod['description'],
          inputSchema: mod['inputSchema'] as never,
          execute: mod['execute'] as never,
        });
        infos.push({ name: namespacedName, description: mod['description'] });
        continue;
      }

      // Try named export matching toolName (original behavior)
      const toolDefByName = mod[toolName] as ToolSet[string] | undefined;
      if (toolDefByName) {
        tools[namespacedName] = toolDefByName;
        infos.push({ name: namespacedName, description: extractDescription(mod, toolName, toolDefByName) });
        continue;
      }

      // Unrecognized export shape
      logger?.warn(`Unrecognized plugin export shape for ${toolName}`, {
        team: teamName,
        tool: toolName,
      });
    } catch (err) {
      (logger?.error ?? logger?.warn)?.(`Plugin load failed for ${toolName}`, {
        team: teamName,
        tool: toolName,
        error: errorMessage(err),
      });
    }
  }

  return { tools, infos };
}
