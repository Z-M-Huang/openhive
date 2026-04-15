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

  it('returns one tool per subagent definition', () => {
    const registry = makeMockRegistry();
    const result = buildSubagentTools({
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

  it('each tool has the correct description from the definition', () => {
    const registry = makeMockRegistry();
    const result = buildSubagentTools({
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

  it('resolves the model from the registry using profileName:modelId', () => {
    const registry = makeMockRegistry();
    buildSubagentTools({
      registry,
      profileName: 'myprofile',
      modelId: 'claude-opus',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
    });

    expect(registry.languageModel).toHaveBeenCalledWith('myprofile:claude-opus');
  });

  it('uses custom maxSteps when provided', () => {
    const registry = makeMockRegistry();

    buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
      maxSteps: 25,
    });

    expect(mockStepCountIs).toHaveBeenCalledWith(25);
  });

  it('uses default maxSteps (10) when not provided', () => {
    const registry = makeMockRegistry();

    buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
    });

    expect(mockStepCountIs).toHaveBeenCalledWith(10);
  });

  it('returns empty record when no subagent definitions', () => {
    const registry = makeMockRegistry();
    const result = buildSubagentTools({
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

    const result = buildSubagentTools({
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
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.model).toEqual({ modelId: 'test-model' });
    expect(callArgs.system).toBe('You are a DevOps engineer.');
    expect(callArgs.prompt).toBe('deploy to production');
    expect(callArgs.tools).toBe(sharedTools);
    // stopWhen is whatever stepCountIs(7) returned from the mock
    expect(callArgs.stopWhen).toEqual({ type: 'stepCount', count: 7 });
    expect(callArgs.abortSignal).toBe(controller.signal);
  });

  it('tool execute returns structured { subagent, text, steps } envelope', async () => {
    const registry = makeMockRegistry();
    mockGenerateText.mockResolvedValue({
      text: 'deployment complete',
      steps: [{ stepId: 1 }, { stepId: 2 }, { stepId: 3 }],
    });

    const result = buildSubagentTools({
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

    const result = buildSubagentTools({
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

    const result = buildSubagentTools({
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
