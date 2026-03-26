/**
 * Layer 11 Phase Gate -- Security E2E (Suites 11-12)
 *
 * E2E-11: Tool defense bypass -- tests all 3 layers.
 * E2E-12: Credential leakage audit -- secrets never appear in plaintext output.
 */

import { describe, it, expect } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

import { createCanUseTool } from '../sessions/can-use-tool.js';
import { createWorkspaceBoundaryHook } from '../hooks/workspace-boundary.js';
import { createToolInvoker } from '../org-mcp/registry.js';
import type { OrgMcpDeps } from '../org-mcp/registry.js';
import { OrgTree } from '../domain/org-tree.js';
import type { IOrgStore } from '../domain/interfaces.js';
import type { OrgTreeNode, TeamConfig } from '../domain/types.js';
import { TeamStatus } from '../domain/types.js';
import { SecretString } from '../secrets/secret-string.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';
import { createAuditPreHook } from '../hooks/audit-logger.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function memoryOrgStore(): IOrgStore {
  const data = new Map<string, OrgTreeNode>();
  return {
    addTeam(n: OrgTreeNode) { data.set(n.teamId, n); },
    removeTeam(id: string) { data.delete(id); },
    getTeam(id: string) { return data.get(id); },
    getChildren(pid: string) { return [...data.values()].filter((n) => n.parentId === pid); },
    getAncestors() { return []; },
    getAll() { return [...data.values()]; },
    addScopeKeywords() {},
    removeScopeKeywords() {},
    getOwnScope() { return []; },
    getEffectiveScope() { return []; },
  };
}

function makeNode(o: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return { parentId: null, status: TeamStatus.Active, agents: [], children: [], ...o };
}

/** Cast partial hook input for tests — our hooks only read tool_name + tool_input. */
function hookInput(obj: Record<string, unknown>): HookInput {
  return obj as unknown as HookInput;
}
const hookOpts = { signal: new AbortController().signal };
const canUseToolOpts = { signal: new AbortController().signal, toolUseID: 'test-tu' };

// ── E2E-11: Tool Defense Bypass ──────────────────────────────────────────

describe('E2E-11: Tool defense bypass -- 3 layers', () => {
  it('Layer 1: canUseTool denies Bash by default', async () => {
    const check = createCanUseTool(['Read', 'Write', 'Edit', 'mcp__org__*']);

    expect((await check('Bash', {}, canUseToolOpts)).behavior).toBe('deny');
    expect((await check('Read', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await check('mcp__org__spawn_team', {}, canUseToolOpts)).behavior).toBe('allow');
    // Unlisted tool also denied
    expect((await check('Grep', {}, canUseToolOpts)).behavior).toBe('deny');
  });

  it('Layer 1: canUseTool allows Bash only if explicitly listed', async () => {
    const check = createCanUseTool(['Bash', 'Read']);
    expect((await check('Bash', {}, canUseToolOpts)).behavior).toBe('allow');
  });

  it('Layer 2: workspace boundary blocks file access outside cwd', async () => {
    const hook = createWorkspaceBoundaryHook('/app/workspace', ['/app/common']);
    const blocked = await hook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/etc/shadow' } }),
      'tu-1', hookOpts,
    );
    const out = (blocked as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
    expect(out?.['permissionDecision']).toBe('deny');

    const allowed = await hook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/app/workspace/file.ts' } }),
      'tu-2', hookOpts,
    );
    expect(allowed).toEqual({});

    const commonAllowed = await hook(
      hookInput({ tool_name: 'Glob', tool_input: { path: '/app/common' } }),
      'tu-3', hookOpts,
    );
    expect(commonAllowed).toEqual({});
  });

  it('Layer 3: Org MCP validates caller authorization', async () => {
    const store = memoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'team-a', name: 'team-a', parentId: 'root' }));
    tree.addTeam(makeNode({ teamId: 'team-b', name: 'team-b', parentId: 'root' }));

    const configs = new Map<string, TeamConfig>();
    configs.set('team-a', {
      name: 'team-a', parent: 'root', description: '', maxTurns: 50,
      allowed_tools: [], mcp_servers: [], provider_profile: 'default',
    });

    const deps: OrgMcpDeps = {
      orgTree: tree,
      runDir: '/tmp/test-run',
      taskQueue: {
        enqueue: () => 'task-1', dequeue: () => undefined, peek: () => undefined,
        getByTeam: () => [], updateStatus: () => {}, updateResult: () => {}, getPending: () => [], getByStatus: () => [],
      },
      escalationStore: {
        create: () => {}, updateStatus: () => {}, getByCorrelationId: () => undefined,
      },
      spawner: { spawn: async () => 'sid' },
      sessionManager: { getSession: async () => null, terminateSession: async () => {} },
      loadConfig: (n) => { const c = configs.get(n); if (!c) throw new Error('no cfg'); return c; },
      getTeamConfig: (id) => configs.get(id),
      log: () => {},
    };
    const server = createToolInvoker(deps);

    // Sibling cannot delegate to another sibling's child
    const res = await server.invoke(
      'delegate_task', { team: 'team-a', task: 'task work' }, 'team-b',
    ) as { success: boolean; reason: string };
    expect(res.success).toBe(false);
    expect(res.reason).toContain('not parent');

    // Sibling cannot send message to sibling
    const msgRes = await server.invoke(
      'send_message', { target: 'team-b', message: 'hi' }, 'team-a',
    ) as { success: boolean; error: string };
    expect(msgRes.success).toBe(false);

    // Sibling cannot shutdown another sibling
    const shutRes = await server.invoke(
      'shutdown_team', { name: 'team-a' }, 'team-b',
    ) as { success: boolean };
    expect(shutRes.success).toBe(false);
  });

  it('all 3 defense layers compose (end-to-end)', async () => {
    // 1. canUseTool denies Bash
    const check = createCanUseTool(['Read', 'Write', 'mcp__org__*']);
    expect((await check('Bash', {}, canUseToolOpts)).behavior).toBe('deny');

    // 2. Even if a tool is allowed, boundary blocks outside-workspace access
    expect((await check('Read', {}, canUseToolOpts)).behavior).toBe('allow');
    const hook = createWorkspaceBoundaryHook('/app/workspace', []);
    const boundaryResult = await hook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/root/.ssh/id_rsa' } }),
      'tu-x', hookOpts,
    );
    const bOut = (boundaryResult as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
    expect(bOut?.['permissionDecision']).toBe('deny');

    // 3. Even if file access passes, Org MCP validates team relationships
    expect((await check('mcp__org__delegate_task', {}, canUseToolOpts)).behavior).toBe('allow');
    // (authorization tested in Layer 3 test above)
  });
});

// ── E2E-12: Credential Leakage Audit ────────────────────────────────────

describe('E2E-12: Credential leakage audit', () => {
  it('SecretString never leaks via toString, JSON.stringify, or template literal', () => {
    const secret = new SecretString('super-secret-api-key-12345');

    expect(secret.toString()).toBe('[REDACTED]');
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(`${String(secret)}`).toBe('[REDACTED]');
    expect(`key=${String(secret)}`).not.toContain('super-secret');
  });

  it('credential scrubber removes known secrets from text', () => {
    const secret = new SecretString('my-secret-value-xyz');
    const text = 'Connecting with key: my-secret-value-xyz to server';
    const scrubbed = scrubSecrets(text, [secret]);
    expect(scrubbed).not.toContain('my-secret-value-xyz');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('credential scrubber catches common API key patterns', () => {
    const text = 'Using api_key=sk-1234567890abcdefghijklmnop and Bearer eyJtoken.payload.sig';
    const scrubbed = scrubSecrets(text, []);

    expect(scrubbed).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(scrubbed).not.toContain('eyJtoken.payload.sig');
  });

  it('audit hook redacts secret-like values in tool input', async () => {
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = { info: (msg: string, meta?: Record<string, unknown>) => { logs.push({ msg, meta }); } };
    const secret = new SecretString('api-key-secret-value');
    const { hook } = createAuditPreHook(logger, [secret]);

    await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: '/app/f.ts', content: 'api-key-secret-value' } }),
      'tu-sec', hookOpts,
    );

    expect(logs).toHaveLength(1);
    const params = logs[0].meta?.['params'] as Record<string, unknown>;
    expect(params['content']).toBe('[REDACTED]');
    expect(params['file_path']).toBe('/app/f.ts');
  });

  it('full chain: secret used in session config, all outputs scrubbed', () => {
    const apiKey = new SecretString('sk-anthropic-real-key-do-not-leak-abcdef');
    const dbPass = new SecretString('p@ssw0rd!123');
    const secrets = [apiKey, dbPass];

    // Simulate log output that might contain secrets
    const logLine = `Connecting to API with sk-anthropic-real-key-do-not-leak-abcdef, db password is p@ssw0rd!123`;
    const scrubbed = scrubSecrets(logLine, secrets);

    expect(scrubbed).not.toContain('sk-anthropic-real-key-do-not-leak-abcdef');
    expect(scrubbed).not.toContain('p@ssw0rd!123');
    expect(scrubbed.match(/\[REDACTED]/g)?.length).toBeGreaterThanOrEqual(2);

    // Verify the secret objects themselves don't leak
    const serialized = JSON.stringify({ key: apiKey, pass: dbPass });
    expect(serialized).not.toContain('sk-anthropic');
    expect(serialized).not.toContain('p@ssw0rd');
  });
});
