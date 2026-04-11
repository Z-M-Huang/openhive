/**
 * Plugin tool loader — loads plugin tools from the filesystem with namespace isolation.
 *
 * Each plugin tool is namespaced as `teamName.toolName` to prevent collisions.
 * Tools are only loaded if they are registered in the plugin tool store with
 * status 'active', pass the allowed_tools filter, and exist on disk.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ToolSet } from 'ai';
import type { IPluginToolStore } from '../../domain/interfaces.js';

export const RESERVED_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'bash'];

export async function loadPluginTools(
  teamName: string,
  requiredTools: string[],
  allowedTools: readonly string[],
  pluginToolStore: IPluginToolStore,
  runDir: string,
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
      const toolDef = (mod['default'] ?? mod[toolName]) as ToolSet[string] | undefined;
      if (!toolDef) continue;

      tools[namespacedName] = toolDef;
    } catch {
      // Failed to load — skip silently (registration-time verification catches issues)
    }
  }

  return tools;
}
