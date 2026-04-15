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

export async function loadPluginTools(
  teamName: string,
  requiredTools: string[],
  allowedTools: readonly string[],
  pluginToolStore: IPluginToolStore,
  runDir: string,
  logger?: PluginLoaderLogger,
): Promise<ToolSet> {
  const tools: ToolSet = {};

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
        continue;
      }

      // Try named export matching toolName (original behavior)
      const toolDefByName = mod[toolName] as ToolSet[string] | undefined;
      if (toolDefByName) {
        tools[namespacedName] = toolDefByName;
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

  return tools;
}
