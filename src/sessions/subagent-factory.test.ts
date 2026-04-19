/**
 * Subagent Factory tests.
 *
 * Validates (post-AC-23):
 * 1. buildSubagentTools returns a tool for each subagent definition
 * 2. Each tool has the correct description
 * 3. Tool execution calls `generateText()` with the subagent's system prompt
 * 4. Tool execution returns the structured `{ subagent, text, steps }` envelope
 * 5. loadSubagents returns SubagentDefinition (not AgentDefinition)
 * 6. subagent-factory.ts does NOT import ToolLoopAgent or claude-agent-sdk
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

// ── Mock the 'ai' module ──────────────────────────────────────────────────────

// `vi.mock` is hoisted, so we cannot reference module-level variables inside
// the factory. `vi.hoisted()` creates the spy instances before the hoist so
// both the mock factory and the test bodies see the same handles.
const { mockGenerateText, mockStepCountIs, mockTool } = vi.hoisted(() => {
  const mockGenerateText = vi.fn();
  const mockStepCountIs = vi.fn((n: number) => ({ type: 'stepCount', count: n }));
  const mockTool = vi.fn((def: Record<string, unknown>) => def);
  return { mockGenerateText, mockStepCountIs, mockTool };
});

vi.mock('ai', () => ({
  generateText: mockGenerateText,
  stepCountIs: mockStepCountIs,
  tool: mockTool,
}));

import { buildSubagentTools } from './subagent-factory.js';
import type { SubagentDefinition } from './skill-loader.js';
import { loadSubagents } from './skill-loader.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockRegistry() {
  const mockModel = { modelId: 'test-model' };
  return {
    languageModel: vi.fn().mockReturnValue(mockModel),
    textEmbeddingModel: vi.fn(),
    imageModel: vi.fn(),
    embeddingModel: vi.fn(),
    transcriptionModel: vi.fn(),
    speechModel: vi.fn(),
    rerankingModel: vi.fn(),
  } as unknown as import('./provider-registry.js').ProviderRegistryProvider;
}

const sampleDefs: Record<string, SubagentDefinition> = {
  devops: {
    description: 'Handles deployments and infrastructure',
    prompt: 'You are a DevOps engineer.',
    skills: ['deploy', 'rollback'],
  },
  reviewer: {
    description: 'Reviews code changes',
    prompt: 'You are a code reviewer.',
    skills: ['review'],
  },
};

// ── buildSubagentTools ────────────────────────────────────────────────────────

describe('buildSubagentTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: resolve with a minimal GenerateTextResult shape so tests that
    // don't override this don't hang.
    mockGenerateText.mockResolvedValue({ text: '', steps: [] });
  });

  it('returns one tool per subagent definition', async () => {
    const registry = makeMockRegistry();
    const result = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: sampleDefs,
      tools: {},
    });

    const keys = Object.keys(result);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('devops');
    expect(keys).toContain('reviewer');
  });

  it('each tool has the correct description from the definition', async () => {
    const registry = makeMockRegistry();
    const result = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: sampleDefs,
      tools: {},
    });

    // tool() mock returns the definition object directly
    expect((result['devops'] as unknown as import('ai').ToolSet).description).toBe(
      'Handles deployments and infrastructure',
    );
    expect((result['reviewer'] as unknown as import('ai').ToolSet).description).toBe(
      'Reviews code changes',
    );
  });

  it('resolves the model from the registry using profileName:modelId', async () => {
    const registry = makeMockRegistry();
    await buildSubagentTools({
      registry,
      profileName: 'myprofile',
      modelId: 'claude-opus',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
    });

    expect(registry.languageModel).toHaveBeenCalledWith('myprofile:claude-opus');
  });

  it('uses custom maxSteps when provided', async () => {
    const registry = makeMockRegistry();

    await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
      maxSteps: 25,
    });

    expect(mockStepCountIs).toHaveBeenCalledWith(25);
  });

  it('uses default maxSteps (100) when not provided', async () => {
    const registry = makeMockRegistry();

    await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
    });

    expect(mockStepCountIs).toHaveBeenCalledWith(100);
  });

  it('returns empty record when no subagent definitions', async () => {
    const registry = makeMockRegistry();
    const result = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: {},
      tools: {},
    });

    expect(Object.keys(result)).toHaveLength(0);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockStepCountIs).not.toHaveBeenCalled();
  });

  it('tool execute calls generateText with system prompt, task, tools, stopWhen and signal', async () => {
    const registry = makeMockRegistry();
    const sharedTools = { myTool: { execute: vi.fn() } };
    mockGenerateText.mockResolvedValue({ text: 'deployment complete', steps: [{}, {}, {}] });

    const result = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: sharedTools as unknown as import('ai').ToolSet,
      maxSteps: 7,
    });

    const toolDef = result['solo'] as unknown as Record<string, unknown>;
    const execute = toolDef['execute'] as (
      input: { task: string },
      opts: { abortSignal?: AbortSignal },
    ) => Promise<{ subagent: string; text: string; steps: number }>;

    const controller = new AbortController();
    await execute(
      { task: 'deploy to production' },
      { abortSignal: controller.signal },
    );

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['model']).toEqual({ modelId: 'test-model' });
    // Fix 6: subagent-factory now wraps the raw def.prompt with the shared
    // `--- Active Subagent ---` header plus the standing `--- Subagent Default
    // Behavior ---` directive so skill → plugin → generic routing is enforced
    // on the legacy delegated path too. The original prompt text must still be
    // present verbatim inside the augmented system string.
    expect(callArgs['system']).toContain('You are a DevOps engineer.');
    expect(callArgs['system']).toContain('--- Active Subagent: solo ---');
    expect(callArgs['system']).toContain('--- Subagent Default Behavior ---');
    expect(callArgs['prompt']).toBe('deploy to production');
    expect(callArgs['tools']).toBe(sharedTools);
    // stopWhen is whatever stepCountIs(7) returned from the mock
    expect(callArgs['stopWhen']).toEqual({ type: 'stepCount', count: 7 });
    expect(callArgs['abortSignal']).toBe(controller.signal);
  });

  it('tool execute returns structured { subagent, text, steps } envelope', async () => {
    const registry = makeMockRegistry();
    mockGenerateText.mockResolvedValue({
      text: 'deployment complete',
      steps: [{ stepId: 1 }, { stepId: 2 }, { stepId: 3 }],
    });

    const result = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
    });

    const toolDef = result['solo'] as unknown as Record<string, unknown>;
    const execute = toolDef['execute'] as (
      input: { task: string },
      opts: { abortSignal?: AbortSignal },
    ) => Promise<{ subagent: string; text: string; steps: number }>;

    const output = await execute({ task: 'deploy' }, {});

    expect(output).toEqual({
      subagent: 'solo',
      text: 'deployment complete',
      steps: 3,
    });
  });

  it('tool execute returns steps=0 when the SDK result omits the steps array', async () => {
    // Defensive: if the SDK ever returns no `steps` field we must not blow up
    // with `.length of undefined` — the subagent envelope should still be
    // well-formed so audit logs stay usable.
    const registry = makeMockRegistry();
    mockGenerateText.mockResolvedValue({ text: 'done' });

    const result = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
    });

    const toolDef = result['solo'] as unknown as Record<string, unknown>;
    const execute = toolDef['execute'] as (
      input: { task: string },
      opts: { abortSignal?: AbortSignal },
    ) => Promise<{ subagent: string; text: string; steps: number }>;

    const output = await execute({ task: 'x' }, {});

    expect(output).toEqual({ subagent: 'solo', text: 'done', steps: 0 });
  });

  it('preserves subagent identity in the envelope when multiple subagents run', async () => {
    // With multiple subagents, each tool's envelope must carry the correct
    // name — a regression here would make tool traces misleading.
    const registry = makeMockRegistry();
    mockGenerateText.mockResolvedValue({ text: 'reply', steps: [{}] });

    const result = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: sampleDefs,
      tools: {},
    });

    const execDevops = (result['devops'] as unknown as Record<string, unknown>)['execute'] as (
      input: { task: string },
      opts: { abortSignal?: AbortSignal },
    ) => Promise<{ subagent: string; text: string; steps: number }>;
    const execReviewer = (result['reviewer'] as unknown as Record<string, unknown>)['execute'] as (
      input: { task: string },
      opts: { abortSignal?: AbortSignal },
    ) => Promise<{ subagent: string; text: string; steps: number }>;

    const devopsOut = await execDevops({ task: 'a' }, {});
    const reviewerOut = await execReviewer({ task: 'b' }, {});

    expect(devopsOut.subagent).toBe('devops');
    expect(reviewerOut.subagent).toBe('reviewer');
  });
});

// ── loadSubagents returns SubagentDefinition ──────────────────────────────────

describe('loadSubagents returns SubagentDefinition', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-u7-subagent-'));
    mkdirSync(join(dir, 'teams', 'test-team', 'subagents'), { recursive: true });
  });

  it('returns objects conforming to SubagentDefinition shape', () => {
    const content =
      '# Agent: Deployer\n## Role\nDeploys services\n## Skills\n- deploy — run deploys\n';
    writeFileSync(
      join(dir, 'teams', 'test-team', 'subagents', 'deployer.md'),
      content,
    );

    const agents = loadSubagents(dir, 'test-team');
    const deployer = agents['Deployer'];

    // Verify SubagentDefinition shape
    expect(deployer).toBeDefined();
    expect(typeof deployer.description).toBe('string');
    expect(typeof deployer.prompt).toBe('string');
    expect(Array.isArray(deployer.skills)).toBe(true);
    expect(deployer.description).toBe('Deploys services');
    expect(deployer.skills).toEqual(['deploy']);
    expect(deployer.prompt).toContain('# Agent: Deployer');
  });
});

// ── No claude-agent-sdk import in skill-loader.ts ─────────────────────────────

describe('skill-loader.ts has no claude-agent-sdk import', () => {
  it('does not import from @anthropic-ai/claude-agent-sdk', () => {
    const source = readFileSync(
      join(__dirname, 'skill-loader.ts'),
      'utf-8',
    );
    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('exports SubagentDefinition interface', () => {
    const source = readFileSync(
      join(__dirname, 'skill-loader.ts'),
      'utf-8',
    );
    expect(source).toContain('export interface SubagentDefinition');
  });
});

// ── subagent-factory.ts has no claude-agent-sdk or ToolLoopAgent ──────────────

describe('subagent-factory.ts is ToolLoopAgent-free', () => {
  it('does not import from @anthropic-ai/claude-agent-sdk', () => {
    const source = readFileSync(
      join(__dirname, 'subagent-factory.ts'),
      'utf-8',
    );
    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('does not reference ToolLoopAgent (replaced by generateText per AC-23)', () => {
    const source = readFileSync(
      join(__dirname, 'subagent-factory.ts'),
      'utf-8',
    );
    expect(source).not.toContain('ToolLoopAgent');
  });
});

// ── Plugin merge + maxSteps (AC-11, AC-12, AC-15.4) ─────────────────────────

/** Minimal stub that satisfies `IPluginToolStore` for tests. */
function makePluginStore(ops: Record<string, Record<string, { status: string }>>) {
  return {
    get: (teamName: string, toolName: string) => {
      const team = ops[teamName];
      if (!team || !team[toolName]) return undefined;
      return {
        teamName,
        toolName,
        status: team[toolName].status,
        sourcePath: '',
        sourceHash: '',
        verification: {},
        createdAt: '',
        updatedAt: '',
        verifiedAt: null,
      };
    },
    getByTeam: () => [] as never,
    getAll: () => [] as never,
    upsert: () => {},
    setStatus: () => {},
    deprecate: () => {},
    markRemoved: () => {},
    remove: () => {},
    removeByTeam: () => {},
  } as import('../domain/interfaces.js').IPluginToolStore;
}

/** Create a minimal tool object for baseline tool sets. */
function makeStubTool() {
  return {
    description: 'stub',
    inputSchema: {} as never,
    execute: async () => ({ result: 'ok' }),
  } as unknown as import('ai').ToolSet[string];
}

/** Write a temporary plugin fixture file and return its directory as runDir. */
async function writePluginFixture(teamName: string, toolName: string): Promise<string> {
  const runDir = mkdtempSync(join(tmpdir(), 'openhive-plugin-'));
  const pluginDir = join(runDir, 'teams', teamName, 'plugins');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, `${toolName}.ts`),
    `export const description = '${toolName} plugin';\nexport const inputSchema = {};\nexport const execute = async () => ({ ok: true });\n`,
  );
  return runDir;
}

describe('subagent-factory plugin merge + maxSteps', () => {
  beforeEach(() => { mockGenerateText.mockReset(); });

  it('merges plugin tools from resolvedSkills into generateText tools', async () => {
    mockGenerateText.mockResolvedValue({ text: 'ok', steps: [] });
    const registry = makeMockRegistry();
    const def: SubagentDefinition = {
      description: '',
      prompt: 'monitor logs',
      skills: ['alert-check'],
      resolvedSkills: [{ name: 'alert-check', content: '', requiredTools: ['query_loggly'] }],
    };
    const store = makePluginStore({ ops: { query_loggly: { status: 'active' } } });
    const runDir = await writePluginFixture('ops', 'query_loggly');
    // Pass both current and future interface fields
    const tools = await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'test',
      subagentDefs: { 'loggly-monitor': def },
      teamName: 'ops',
      tools: { baseTool: makeStubTool() },
      allowedTools: ['*'],
      pluginToolStore: store,
      runDir,
    });

    type ExecutableTool = { execute: (input: unknown, opts: unknown) => Promise<unknown> };
    await (tools['loggly-monitor'] as unknown as ExecutableTool).execute(
      { task: 'go' },
      { abortSignal: new AbortController().signal },
    );

    const call = mockGenerateText.mock.calls[0][0] as { tools?: Record<string, unknown> };
    // Current code passes opts.tools verbatim — no plugin merge.
    // Expectation: plugin tools should be present (will fail until AC-11 is implemented).
    expect(Object.keys(call.tools ?? {})).toEqual(
      expect.arrayContaining(['baseTool', 'ops.query_loggly']),
    );
  });

  it('propagates opts.maxSteps to stepCountIs', async () => {
    mockGenerateText.mockResolvedValue({ text: '', steps: [] });
    // Use new interface — both opts.subagents and opts.subagentDefs are supported.
    const tools = await buildSubagentTools({
      teamName: 'ops',
      tools: {},
      allowedTools: ['*'],
      pluginToolStore: makePluginStore({}),
      runDir: '/tmp',
      subagents: { a: { name: 'a', prompt: '', resolvedSkills: [] } },
      maxSteps: 200,
    });
    type ExecutableTool = { execute: (input: unknown, opts: unknown) => Promise<unknown> };
    await (tools['a'] as unknown as ExecutableTool).execute(
      { task: 't' },
      { abortSignal: new AbortController().signal },
    );
    expect(mockStepCountIs).toHaveBeenCalledWith(200);
  });

  it('defaults maxSteps to 100 (not 10) when omitted', async () => {
    mockGenerateText.mockResolvedValue({ text: '', steps: [] });
    const registry = makeMockRegistry();
    await buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'test',
      subagentDefs: { a: { description: '', prompt: '', skills: [] } },
    });
    // AC-12: new default should be 100, not 10.
    expect(mockStepCountIs).toHaveBeenCalledWith(100);
    expect(mockStepCountIs).not.toHaveBeenCalledWith(10);
  });

  it('does NOT contain the DEFAULT_MAX_STEPS = 10 constant', () => {
    const src = readFileSync(
      join(__dirname, 'subagent-factory.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/DEFAULT_MAX_STEPS\s*=\s*10/);
  });

  it('passes only opts.tools when resolvedSkills is empty', async () => {
    mockGenerateText.mockResolvedValue({ text: '', steps: [] });
    // Use new interface — both opts.subagents and opts.subagentDefs are supported.
    const tools = await buildSubagentTools({
      teamName: 'ops',
      tools: { baseTool: makeStubTool() },
      allowedTools: ['*'],
      pluginToolStore: makePluginStore({}),
      runDir: '/tmp',
      subagents: { a: { name: 'a', prompt: '', resolvedSkills: [] } },
    });

    type ExecutableTool = { execute: (input: unknown, opts: unknown) => Promise<unknown> };
    await (tools['a'] as unknown as ExecutableTool).execute(
      { task: 't' },
      { abortSignal: new AbortController().signal },
    );

    const call = mockGenerateText.mock.calls[0][0] as { tools?: Record<string, unknown> };
    expect(Object.keys(call.tools ?? {})).toEqual(['baseTool']);
  });
});
