/**
 * MCP tools index — barrel that composes all handler categories.
 *
 * @module mcp/tools
 */

// Re-export types
export type { ToolContext, PendingMemoryWrite, ToolHandler, SDKToolHandlerResult } from './types.js';

// Re-export schemas and constants
export { TOOL_SCHEMAS, TOOL_NAMES, TOOL_COUNT } from './schemas.js';

// Re-export helpers
export { assertNotPrivateUrl, generateId, resolveSecretsTemplate, resolveSecretsTemplatesInObject } from './helpers.js';

// Re-export SDKToolHandler class
export { SDKToolHandler } from './sdk-tool-handler.js';

// Re-export handler factories (for direct use if needed)
export { createContainerHandlers } from './handlers-container.js';
export { createTeamHandlers } from './handlers-team.js';
export { createTaskHandlers } from './handlers-task.js';
export { createMemoryHandlers } from './handlers-memory.js';
export { createIntegrationHandlers } from './handlers-integration.js';
export { createCredentialHandlers } from './handlers-credential.js';
export { createQueryHandlers } from './handlers-query.js';
export { createSkillHandlers } from './handlers-skill.js';

import type { ToolContext, ToolHandler } from './types.js';
import { createContainerHandlers } from './handlers-container.js';
import { createTeamHandlers } from './handlers-team.js';
import { createTaskHandlers } from './handlers-task.js';
import { createMemoryHandlers } from './handlers-memory.js';
import { createIntegrationHandlers } from './handlers-integration.js';
import { createCredentialHandlers } from './handlers-credential.js';
import { createQueryHandlers } from './handlers-query.js';
import { createSkillHandlers } from './handlers-skill.js';

/**
 * Creates all tool handler functions, closed over the provided ToolContext.
 * Returns a Map<string, ToolHandler>.
 */
export function createToolHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  // Compose all handler categories
  const categories = [
    createContainerHandlers(ctx),
    createTeamHandlers(ctx),
    createTaskHandlers(ctx),
    createMemoryHandlers(ctx),
    createIntegrationHandlers(ctx),
    createCredentialHandlers(ctx),
    createQueryHandlers(ctx),
    createSkillHandlers(ctx),
  ];

  for (const category of categories) {
    for (const [name, handler] of category) {
      handlers.set(name, handler);
    }
  }

  return handlers;
}
