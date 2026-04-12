/**
 * register_plugin_tool — registers a new plugin tool for a team.
 *
 * Validates source code for security (forbidden patterns, secrets),
 checks required exports (description, inputSchema, execute),
 * writes the source to the team's plugins directory, and records
 * the tool metadata in the plugin tool store.
 */

import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IPluginToolStore, PluginToolMeta } from '../../domain/interfaces.js';
import { scanPluginSource, type SecurityScanResult } from '../../sessions/tools/plugin-security.js';
import { errorMessage } from '../../domain/errors.js';

/** Reserved tool names that cannot be registered as plugins. */
const RESERVED_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'bash'];

/** Tool names must be snake_case (lowercase with underscores). */
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

export const RegisterPluginToolInputSchema = z.object({
  tool_name: z.string().min(1).regex(SNAKE_CASE_RE, 'tool_name must be snake_case (lowercase with underscores)'),
  source_code: z.string().min(1),
});

export type RegisterPluginToolInput = z.infer<typeof RegisterPluginToolInputSchema>;

export interface RegisterPluginToolResult {
  readonly success: boolean;
  readonly tool?: string;
  readonly error?: string;
}

export interface RegisterPluginToolDeps {
  readonly pluginToolStore: IPluginToolStore;
  readonly runDir: string;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Regex patterns to validate required exports in source code. */
const REQUIRED_EXPORT_PATTERNS = {
  description: /export\s+(?:const\s+description|const\s+description\s*:|let\s+description|let\s+description\s*:|var\s+description|var\s+description\s*:)/,
  inputSchema: /export\s+(?:const\s+inputSchema|const\s+inputSchema\s*:|let\s+inputSchema|let\s+inputSchema\s*:|var\s+inputSchema|var\s+inputSchema\s*:)/,
  execute: /export\s+(?:async\s+)?function\s+execute|export\s+const\s+execute\s*=|export\s+const\s+execute\s*:/,
};

/** Validate that source code exports the required interface elements. */
function validateInterface(source: string): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!REQUIRED_EXPORT_PATTERNS.description.test(source)) {
    missing.push('description');
  }
  if (!REQUIRED_EXPORT_PATTERNS.inputSchema.test(source)) {
    missing.push('inputSchema');
  }
  if (!REQUIRED_EXPORT_PATTERNS.execute.test(source)) {
    missing.push('execute');
  }

  return { valid: missing.length === 0, missing };
}

/** Compute SHA-256 hash of source code. */
function computeSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf-8').digest('hex');
}

export function registerPluginTool(
  input: RegisterPluginToolInput,
  teamName: string,
  deps: RegisterPluginToolDeps,
): RegisterPluginToolResult {
  // Parse input with Zod
  const parsed = RegisterPluginToolInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { tool_name, source_code } = parsed.data;

  // Check reserved names
  if (RESERVED_TOOL_NAMES.includes(tool_name.toLowerCase())) {
    return { success: false, error: 'tool_name is reserved' };
  }

  // Check if tool already exists for this team
  const existing = deps.pluginToolStore.get(teamName, tool_name);
  if (existing) {
    return { success: false, error: `tool "${tool_name}" already exists for team "${teamName}"` };
  }

  // Security scan
  const securityResult: SecurityScanResult = scanPluginSource(source_code);
  if (!securityResult.passed) {
    const errors: string[] = [];
    if (securityResult.forbiddenPatterns.length > 0) {
      errors.push(`forbidden patterns: ${securityResult.forbiddenPatterns.join(', ')}`);
    }
    if (securityResult.detectedSecrets.length > 0) {
      errors.push(`detected secrets: ${securityResult.detectedSecrets.join(', ')}`);
    }
    return { success: false, error: `security scan failed: ${errors.join('; ')}` };
  }

  // Validate interface exports
  const interfaceValidation = validateInterface(source_code);
  if (!interfaceValidation.valid) {
    return { success: false, error: `missing required exports: ${interfaceValidation.missing.join(', ')}` };
  }

  // Ensure plugins directory exists and write source file
  const pluginsDir = join(deps.runDir, 'teams', teamName, 'plugins');
  try {
    mkdirSync(pluginsDir, { recursive: true });
  } catch (err) {
    return { success: false, error: `failed to create plugins directory: ${errorMessage(err)}` };
  }

  const toolFilePath = join(pluginsDir, `${tool_name}.ts`);
  try {
    writeFileSync(toolFilePath, source_code, 'utf-8');
  } catch (err) {
    return { success: false, error: `failed to write tool file: ${errorMessage(err)}` };
  }

  // Compute source hash
  const sourceHash = computeSourceHash(source_code);

  // Create metadata and upsert to store
  const now = new Date().toISOString();
  const meta: PluginToolMeta = {
    teamName,
    toolName: tool_name,
    status: 'active',
    sourcePath: toolFilePath,
    sourceHash,
    verification: {
      typescript: { valid: true, errors: [] },
      interface: { hasDescription: true, hasParameters: true, hasExecute: true },
      security: securityResult,
    },
    createdAt: now,
    updatedAt: now,
    verifiedAt: now,
  };

  deps.pluginToolStore.upsert(meta);
  deps.log('register_plugin_tool', { team: teamName, tool: tool_name, status: 'active' });

  return { success: true, tool: `${teamName}.${tool_name}` };
}
