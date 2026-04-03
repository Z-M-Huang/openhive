/**
 * Subagent Factory tests.
 *
 * Validates:
 * 1. buildSubagentTools returns a tool for each subagent definition
 * 2. Each tool has the correct description
 * 3. Tool execution delegates to ToolLoopAgent.generate()
 * 4. loadSubagents returns SubagentDefinition (not AgentDefinition)
 * 5. No claude-agent-sdk import in skill-loader.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

// ── Mock the 'ai' module ──────────────────────────────────────────────────────

// vi.mock is hoisted, so we cannot reference top-level variables inside the
// factory. Instead we use vi.hoisted() to declare the mocks before the hoist.
const { mockGenerate, MockToolLoopAgent, mockStepCountIs, mockTool } = vi.hoisted(() => {
  const mockGenerate = vi.fn();
  const MockToolLoopAgent = vi.fn().mockImplementation(() => ({
    generate: mockGenerate,
  }));
  const mockStepCountIs = vi.fn((n: number) => ({ type: 'stepCount', count: n }));
  const mockTool = vi.fn((def: Record<string, unknown>) => def);
  return { mockGenerate, MockToolLoopAgent, mockStepCountIs, mockTool };
});

vi.mock('ai', () => ({
  ToolLoopAgent: MockToolLoopAgent,
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

  it('creates a ToolLoopAgent for each subagent with correct instructions', () => {
    const registry = makeMockRegistry();
    buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: sampleDefs,
      tools: {},
    });

    expect(MockToolLoopAgent).toHaveBeenCalledTimes(2);

    // First call — devops
    const firstCallArgs = MockToolLoopAgent.mock.calls[0][0];
    expect(firstCallArgs.instructions).toBe('You are a DevOps engineer.');
    expect(firstCallArgs.model).toEqual({ modelId: 'test-model' });

    // Second call — reviewer
    const secondCallArgs = MockToolLoopAgent.mock.calls[1][0];
    expect(secondCallArgs.instructions).toBe('You are a code reviewer.');
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

  it('passes the provided tools to each ToolLoopAgent', () => {
    const registry = makeMockRegistry();
    const sharedTools = { myTool: { execute: vi.fn() } };

    buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: sharedTools as unknown as import('ai').ToolSet,
    });

    const agentArgs = MockToolLoopAgent.mock.calls[0][0];
    expect(agentArgs.tools).toBe(sharedTools);
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
    expect(MockToolLoopAgent).not.toHaveBeenCalled();
  });

  it('tool execute delegates to ToolLoopAgent.generate() with prompt and signal', async () => {
    const registry = makeMockRegistry();
    mockGenerate.mockResolvedValue({ text: 'deployment complete' });

    const result = buildSubagentTools({
      registry,
      profileName: 'default',
      modelId: 'claude-sonnet',
      subagentDefs: { solo: sampleDefs['devops'] },
      tools: {},
    });

    // The tool() mock returns the definition object directly,
    // so we can call execute on it
    const toolDef = result['solo'] as unknown as Record<string, unknown>;
    const execute = toolDef['execute'] as (
      input: { task: string },
      opts: { abortSignal?: AbortSignal },
    ) => Promise<string>;

    const controller = new AbortController();
    const output = await execute(
      { task: 'deploy to production' },
      { abortSignal: controller.signal },
    );

    expect(mockGenerate).toHaveBeenCalledWith({
      prompt: 'deploy to production',
      abortSignal: controller.signal,
    });
    expect(output).toBe('deployment complete');
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

// ── subagent-factory.ts has no claude-agent-sdk import ────────────────────────

describe('subagent-factory.ts has no claude-agent-sdk import', () => {
  it('does not import from @anthropic-ai/claude-agent-sdk', () => {
    const source = readFileSync(
      join(__dirname, 'subagent-factory.ts'),
      'utf-8',
    );
    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
