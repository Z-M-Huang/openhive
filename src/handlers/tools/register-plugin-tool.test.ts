/**
 * register_plugin_tool handler tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerPluginTool,
  RegisterPluginToolInputSchema,
  type RegisterPluginToolDeps,
} from './register-plugin-tool.js';
import type { IPluginToolStore, PluginToolMeta } from '../../domain/interfaces.js';

// Factory: In-memory IPluginToolStore
function createMockPluginToolStore(): IPluginToolStore & { records: PluginToolMeta[] } {
  const records: PluginToolMeta[] = [];
  return {
    records,
    upsert(meta: PluginToolMeta): void {
      const idx = records.findIndex(r => r.teamName === meta.teamName && r.toolName === meta.toolName);
      if (idx !== -1) {
        records[idx] = meta;
      } else {
        records.push(meta);
      }
    },
    get(teamName: string, toolName: string): PluginToolMeta | undefined {
      return records.find(r => r.teamName === teamName && r.toolName === toolName);
    },
    getByTeam(teamName: string): PluginToolMeta[] {
      return records.filter(r => r.teamName === teamName);
    },
    getAll(): PluginToolMeta[] {
      return [...records];
    },
    setStatus(teamName: string, toolName: string, status: PluginToolMeta['status']): void {
      const record = this.get(teamName, toolName);
      if (record) {
        Object.assign(record, { status });
      }
    },
    remove(teamName: string, toolName: string): void {
      const idx = records.findIndex(r => r.teamName === teamName && r.toolName === toolName);
      if (idx !== -1) records.splice(idx, 1);
    },
    removeByTeam(teamName: string): void {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].teamName === teamName) records.splice(i, 1);
      }
    },
    deprecate(teamName: string, toolName: string, reason: string, by: string): void {
      const record = this.get(teamName, toolName);
      if (record) {
        const now = new Date().toISOString();
        Object.assign(record, {
          status: 'deprecated',
          deprecatedAt: now,
          deprecatedReason: reason,
          deprecatedBy: by,
          updatedAt: now,
        });
      }
    },
    markRemoved(teamName: string, toolName: string, by: string): void {
      const record = this.get(teamName, toolName);
      if (record) {
        const now = new Date().toISOString();
        Object.assign(record, {
          status: 'removed',
          removedAt: now,
          removedBy: by,
          updatedAt: now,
        });
      }
    },
  };
}

// Valid tool source template
const validToolSource = `export const description = 'A test tool that adds two numbers';

export const inputSchema = {
  type: 'object',
  properties: {
    a: { type: 'number' },
    b: { type: 'number' },
  },
  required: ['a', 'b'],
};

export async function execute(input: { a: number; b: number }) {
  return { result: input.a + input.b };
}
`;

describe('registerPluginTool', () => {
  let runDir: string;
  let store: ReturnType<typeof createMockPluginToolStore>;
  let logMessages: Array<{ msg: string; meta?: Record<string, unknown> }>;
  let deps: RegisterPluginToolDeps;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'openhive-test-'));
    store = createMockPluginToolStore();
    logMessages = [];
    deps = {
      pluginToolStore: store,
      runDir,
      log: (msg: string, meta?: Record<string, unknown>) => {
        logMessages.push({ msg, meta });
      },
    };
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it('registers valid tool → file + DB row with status active', () => {
    const input = {
      tool_name: 'add_numbers',
      source_code: validToolSource,
    };

    const result = registerPluginTool(input, 'test-team', deps);

    expect(result.success).toBe(true);
    expect(result.tool).toBe('test-team.add_numbers');

    // Verify file was written
    const toolFilePath = join(runDir, 'teams', 'test-team', 'plugins', 'add_numbers.ts');
    const fileContent = readFileSync(toolFilePath, 'utf-8');
    expect(fileContent).toBe(validToolSource);

    // Verify DB row
    expect(store.records).toHaveLength(1);
    expect(store.records[0].teamName).toBe('test-team');
    expect(store.records[0].toolName).toBe('add_numbers');
    expect(store.records[0].status).toBe('active');

    // Verify log
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0].msg).toBe('register_plugin_tool');
    expect(logMessages[0].meta).toMatchObject({ team: 'test-team', tool: 'add_numbers', status: 'active' });
  });

  it('rejects source with forbidden patterns (child_process)', () => {
    const maliciousSource = `export const description = 'Malicious tool';
export const inputSchema = { type: 'object', properties: {} };
export async function execute() {
  const { execSync } = require('child_process');
  return execSync('whoami');
}
`;
    const input = {
      tool_name: 'malicious_tool',
      source_code: maliciousSource,
    };

    const result = registerPluginTool(input, 'test-team', deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('security scan failed');
    expect(result.error).toContain('child_process');

    // Verify no file written
    expect(store.records).toHaveLength(0);
  });

  it('rejects source with detected secrets (AWS key)', () => {
    const secretSource = `export const description = 'Tool with secret';
export const inputSchema = { type: 'object', properties: {} };
export async function execute() {
  const key = 'AKIAIOSFODNN7EXAMPLE';
  return { key };
}
`;
    const input = {
      tool_name: 'secret_tool',
      source_code: secretSource,
    };

    const result = registerPluginTool(input, 'test-team', deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('security scan failed');
    expect(result.error).toContain('AKIA');

    // Verify no DB row
    expect(store.records).toHaveLength(0);
  });

  it('rejects reserved tool name', () => {
    const reservedNames = ['read', 'write', 'edit', 'glob', 'grep', 'bash'];

    for (const name of reservedNames) {
      const input = {
        tool_name: name,
        source_code: validToolSource,
      };

      const result = registerPluginTool(input, 'test-team', deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe('tool_name is reserved');
    }

    expect(store.records).toHaveLength(0);
  });

  it('rejects source missing description', () => {
    const missingDescriptionSource = `export const inputSchema = { type: 'object', properties: {} };
export async function execute() {
  return {};
}
`;
    const input = {
      tool_name: 'no_description',
      source_code: missingDescriptionSource,
    };

    const result = registerPluginTool(input, 'test-team', deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing required exports');
    expect(result.error).toContain('description');

    expect(store.records).toHaveLength(0);
  });

  it('rejects source missing inputSchema', () => {
    const missingSchemaSource = `export const description = 'Tool without schema';
export async function execute() {
  return {};
}
`;
    const input = {
      tool_name: 'no_schema',
      source_code: missingSchemaSource,
    };

    const result = registerPluginTool(input, 'test-team', deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing required exports');
    expect(result.error).toContain('inputSchema');

    expect(store.records).toHaveLength(0);
  });

  it('rejects source missing execute', () => {
    const missingExecuteSource = `export const description = 'Tool without execute';
export const inputSchema = { type: 'object', properties: {} };
`;
    const input = {
      tool_name: 'no_execute',
      source_code: missingExecuteSource,
    };

    const result = registerPluginTool(input, 'test-team', deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing required exports');
    expect(result.error).toContain('execute');

    expect(store.records).toHaveLength(0);
  });

  it('InputSchema validates tool_name format', () => {
    const valid = RegisterPluginToolInputSchema.safeParse({
      tool_name: 'valid_tool_name',
      source_code: validToolSource,
    });
    expect(valid.success).toBe(true);

    const invalidUppercase = RegisterPluginToolInputSchema.safeParse({
      tool_name: 'InvalidTool',
      source_code: validToolSource,
    });
    expect(invalidUppercase.success).toBe(false);

    const invalidHyphen = RegisterPluginToolInputSchema.safeParse({
      tool_name: 'invalid-tool',
      source_code: validToolSource,
    });
    expect(invalidHyphen.success).toBe(false);

    const invalidStartNumber = RegisterPluginToolInputSchema.safeParse({
      tool_name: '1invalid',
      source_code: validToolSource,
    });
    expect(invalidStartNumber.success).toBe(false);
  });
});
