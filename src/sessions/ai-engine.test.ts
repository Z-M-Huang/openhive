/**
 * Unit 8: AI Engine Core
 *
 * Tests:
 * 1. runSession returns text from model response
 * 2. onProgress receives assistant_text on first text
 * 3. onProgress receives tool_summary for tool calls
 * 4. stepCount is reported correctly
 * 5. estimateTokens works correctly
 * 6. Context compression triggers at 90% threshold
 * 7. Secret scrubbing on final output
 * 8. No claude-agent-sdk import
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Hoisted mocks for 'ai' module ──────────────────────────────────────────

const {
  mockStreamText,
  mockGenerateText,
  mockStepCountIs,
} = vi.hoisted(() => {
  const mockStreamText = vi.fn();
  const mockGenerateText = vi.fn();
  const mockStepCountIs = vi.fn((n: number) => ({ type: 'stepCount', count: n }));
  return { mockStreamText, mockGenerateText, mockStepCountIs };
});

vi.mock('ai', () => ({
  streamText: mockStreamText,
  generateText: mockGenerateText,
  stepCountIs: mockStepCountIs,
}));

import { runSession, estimateTokens, resolveSystemPrompt } from './ai-engine.js';
import type { AiEngineOpts, ProgressUpdate } from './ai-engine.js';
import { SecretString } from '../secrets/secret-string.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockModel(modelId = 'test-model') {
  return { modelId, provider: 'test' } as unknown as AiEngineOpts['model'];
}

function makeOpts(overrides?: Partial<AiEngineOpts>): AiEngineOpts {
  return {
    model: makeMockModel(),
    system: 'You are a test agent.',
    prompt: 'Do something.',
    tools: {},
    activeTools: [],
    maxTurns: 10,
    contextWindow: 200_000,
    ...overrides,
  };
}

/**
 * Configure mockStreamText to return a result object that mimics StreamTextResult.
 * Captures the onStepFinish callback so tests can invoke it.
 */
function setupStreamTextMock(opts: {
  finalText?: string;
  steps?: Array<{ text?: string; toolCalls?: Array<{ toolName: string }> }>;
}) {
  const capturedCallbacks: {
    onStepFinish?: (event: Record<string, unknown>) => void;
    prepareStep?: (opts: Record<string, unknown>) => unknown;
  } = {};

  const stepResults = (opts.steps ?? []).map((s, i) => ({
    stepNumber: i,
    text: s.text ?? '',
    toolCalls: s.toolCalls ?? [],
  }));

  mockStreamText.mockImplementation((callOpts: Record<string, unknown>) => {
    capturedCallbacks.onStepFinish = callOpts['onStepFinish'] as typeof capturedCallbacks.onStepFinish;
    capturedCallbacks.prepareStep = callOpts['prepareStep'] as typeof capturedCallbacks.prepareStep;

    // Simulate the stream by invoking onStepFinish for each step
    if (capturedCallbacks.onStepFinish) {
      for (const step of stepResults) {
        capturedCallbacks.onStepFinish(step);
      }
    }

    return {
      text: Promise.resolve(opts.finalText ?? ''),
      steps: Promise.resolve(stepResults),
    };
  });

  return capturedCallbacks;
}

// ── estimateTokens ──────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates tokens as chars / 4', () => {
    // JSON.stringify of a simple message
    const msgs = [{ role: 'user', content: 'Hello world' }];
    const json = JSON.stringify(msgs[0]);
    const expected = Math.ceil(json.length / 4);
    expect(estimateTokens(msgs)).toBe(expected);
  });

  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('sums across multiple messages', () => {
    const msgs = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ];
    const totalChars = msgs.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    expect(estimateTokens(msgs)).toBe(Math.ceil(totalChars / 4));
  });
});

// ── runSession ──────────────────────────────────────────────────────────────

describe('runSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns text from model response', async () => {
    setupStreamTextMock({ finalText: 'Task completed successfully.' });

    const result = await runSession(makeOpts());
    expect(result.text).toBe('Task completed successfully.');
  });

  it('reports step count from steps array', async () => {
    setupStreamTextMock({
      finalText: 'done',
      steps: [
        { text: 'Step 1' },
        { text: '' },
        { text: 'Step 3' },
      ],
    });

    const result = await runSession(makeOpts());
    expect(result.steps).toBe(3);
  });

  it('passes model, system, prompt, tools, activeTools to streamText', async () => {
    setupStreamTextMock({ finalText: 'ok' });

    const tools = { Read: { execute: vi.fn() } } as unknown as AiEngineOpts['tools'];
    const opts = makeOpts({
      system: 'Custom system prompt',
      prompt: 'Custom task',
      tools,
      activeTools: ['Read'],
      maxTurns: 5,
    });

    await runSession(opts);

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.model).toBe(opts.model);
    expect(callArgs.system).toBe('Custom system prompt');
    expect(callArgs.prompt).toBe('Custom task');
    expect(callArgs.tools).toBe(tools);
    expect(callArgs.activeTools).toEqual(['Read']);
    expect(mockStepCountIs).toHaveBeenCalledWith(5);
  });

  // ── Progress callbacks ──────────────────────────────────────────────────

  it('onProgress receives assistant_text on first step with text', async () => {
    setupStreamTextMock({
      finalText: 'done',
      steps: [
        { text: 'Working on it...' },
      ],
    });

    const updates: ProgressUpdate[] = [];
    await runSession(makeOpts({
      onProgress: (u) => updates.push(u),
    }));

    const assistantUpdates = updates.filter((u) => u.kind === 'assistant_text');
    expect(assistantUpdates).toHaveLength(1);
    expect(assistantUpdates[0].content).toBe('Working on it...');
  });

  it('onProgress only emits assistant_text for the first step with text', async () => {
    setupStreamTextMock({
      finalText: 'done',
      steps: [
        { text: 'First response' },
        { text: 'Second response' },
      ],
    });

    const updates: ProgressUpdate[] = [];
    await runSession(makeOpts({
      onProgress: (u) => updates.push(u),
    }));

    const assistantUpdates = updates.filter((u) => u.kind === 'assistant_text');
    expect(assistantUpdates).toHaveLength(1);
    expect(assistantUpdates[0].content).toBe('First response');
  });

  it('onProgress receives tool_summary for tool calls', async () => {
    setupStreamTextMock({
      finalText: 'done',
      steps: [
        { text: '', toolCalls: [{ toolName: 'Read' }, { toolName: 'Write' }] },
      ],
    });

    const updates: ProgressUpdate[] = [];
    await runSession(makeOpts({
      onProgress: (u) => updates.push(u),
    }));

    const toolUpdates = updates.filter((u) => u.kind === 'tool_summary');
    expect(toolUpdates).toHaveLength(2);
    expect(toolUpdates[0].content).toBe('Used Read');
    expect(toolUpdates[1].content).toBe('Used Write');
  });

  it('does not crash when onProgress is not provided', async () => {
    setupStreamTextMock({
      finalText: 'done',
      steps: [{ text: 'some text', toolCalls: [{ toolName: 'Bash' }] }],
    });

    const result = await runSession(makeOpts({ onProgress: undefined }));
    expect(result.text).toBe('done');
  });

  // ── Context compression ─────────────────────────────────────────────────

  it('prepareStep triggers compression when over 90% of context window', async () => {
    const callbacks = setupStreamTextMock({ finalText: 'done' });

    mockGenerateText.mockResolvedValue({ text: 'Summary of conversation so far.' });

    await runSession(makeOpts({ contextWindow: 100 }));

    // prepareStep should have been captured
    expect(callbacks.prepareStep).toBeDefined();

    // Simulate calling prepareStep with messages that exceed 90% of window
    // 100 * 0.9 = 90 tokens threshold. Each message ~10 chars => ~2.5 tokens.
    // To exceed 90 tokens at 4 chars/token, we need > 360 chars of JSON.
    const bigMessages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      content: `Message ${i} with some padding to increase token count a bit more`,
    }));

    const result = await callbacks.prepareStep!({
      messages: bigMessages,
      stepNumber: 5,
      model: makeMockModel(),
      steps: [],
      experimental_context: undefined,
    });

    // Should have called generateText for summarization
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const genCallArgs = mockGenerateText.mock.calls[0][0];
    expect(genCallArgs.system).toContain('Summarize preserving');

    // Result should have compressed messages: summary + last 5
    const resolved = await result as { messages: Array<{ role: string; content: string }> };
    expect(resolved).toBeDefined();
    expect(resolved.messages).toBeDefined();
    expect(resolved.messages.length).toBe(6); // 1 summary + 5 recent
    expect(resolved.messages[0].content).toContain('[Previous conversation summary]');
    expect(resolved.messages[0].content).toContain('Summary of conversation so far.');
  });

  it('prepareStep returns undefined when under 90% of context window', async () => {
    const callbacks = setupStreamTextMock({ finalText: 'done' });

    await runSession(makeOpts({ contextWindow: 1_000_000 }));

    expect(callbacks.prepareStep).toBeDefined();

    // Small messages — well under the threshold
    const smallMessages = [{ role: 'user', content: 'Hi' }];
    const result = callbacks.prepareStep!({
      messages: smallMessages,
      stepNumber: 0,
      model: makeMockModel(),
      steps: [],
      experimental_context: undefined,
    });

    expect(result).toBeUndefined();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('prepareStep uses summaryModel when provided', async () => {
    const summaryModel = makeMockModel('summary-model');
    const callbacks = setupStreamTextMock({ finalText: 'done' });

    mockGenerateText.mockResolvedValue({ text: 'Summary.' });

    await runSession(makeOpts({
      contextWindow: 100,
      summaryModel,
    }));

    // Trigger compression with big messages
    const bigMessages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      content: `Message ${i} with padding to exceed the token threshold easily here`,
    }));

    await callbacks.prepareStep!({
      messages: bigMessages,
      stepNumber: 3,
      model: makeMockModel(),
      steps: [],
      experimental_context: undefined,
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText.mock.calls[0][0].model).toBe(summaryModel);
  });

  // ── Secret scrubbing ────────────────────────────────────────────────────

  it('scrubs known SecretString values from output', async () => {
    const secretKey = new SecretString('sk-super-secret-key-12345678');

    setupStreamTextMock({
      finalText: 'The API key is sk-super-secret-key-12345678, done.',
    });

    const result = await runSession(makeOpts({
      knownSecrets: [secretKey],
    }));

    expect(result.text).not.toContain('sk-super-secret-key-12345678');
    expect(result.text).toContain('[REDACTED]');
    expect(result.scrubbed).toBe(true);
  });

  it('scrubs raw string secrets from output', async () => {
    setupStreamTextMock({
      finalText: 'Token: my-raw-secret-value-long-enough, done.',
    });

    const result = await runSession(makeOpts({
      rawSecrets: ['my-raw-secret-value-long-enough'],
    }));

    expect(result.text).not.toContain('my-raw-secret-value-long-enough');
    expect(result.text).toContain('[REDACTED]');
    expect(result.scrubbed).toBe(true);
  });

  it('scrubbed is false when no secrets need redacting', async () => {
    setupStreamTextMock({ finalText: 'Clean output with no secrets.' });

    const result = await runSession(makeOpts({
      knownSecrets: [new SecretString('not-in-output-at-all-1234')],
    }));

    expect(result.text).toBe('Clean output with no secrets.');
    expect(result.scrubbed).toBe(false);
  });

  it('scrubbed is false when no secrets provided', async () => {
    setupStreamTextMock({ finalText: 'No secrets configured.' });

    const result = await runSession(makeOpts());
    expect(result.scrubbed).toBe(false);
  });
});

// ── resolveSystemPrompt ──────────────────────────────────────────────────

describe('resolveSystemPrompt', () => {
  it('passes plain string through as-is', () => {
    const result = resolveSystemPrompt('You are a test agent.');
    expect(result).toBe('You are a test agent.');
  });

  it('returns SystemModelMessage array for two-part prompt', () => {
    const result = resolveSystemPrompt({
      staticPrefix: 'Static part',
      dynamicSuffix: 'Dynamic part',
    });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ role: string; content: string; providerOptions?: Record<string, unknown> }>;
    expect(arr).toHaveLength(2);
    expect(arr[0].role).toBe('system');
    expect(arr[0].content).toBe('Static part');
    expect(arr[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    expect(arr[1].role).toBe('system');
    expect(arr[1].content).toBe('Dynamic part');
    expect(arr[1].providerOptions).toBeUndefined();
  });

  it('omits static block when staticPrefix is empty', () => {
    const result = resolveSystemPrompt({
      staticPrefix: '',
      dynamicSuffix: 'Dynamic only',
    });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ role: string; content: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].content).toBe('Dynamic only');
  });

  it('omits dynamic block when dynamicSuffix is empty', () => {
    const result = resolveSystemPrompt({
      staticPrefix: 'Static only',
      dynamicSuffix: '',
    });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ role: string; content: string; providerOptions?: Record<string, unknown> }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].content).toBe('Static only');
    expect(arr[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('returns empty string when both parts are empty', () => {
    const result = resolveSystemPrompt({
      staticPrefix: '',
      dynamicSuffix: '',
    });
    expect(result).toBe('');
  });

  it('passes two-part prompt through to streamText', async () => {
    vi.clearAllMocks();
    setupStreamTextMock({ finalText: 'ok' });

    await runSession(makeOpts({
      system: { staticPrefix: 'Cached rules', dynamicSuffix: 'Team context' },
    }));

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0][0];
    // Should be a SystemModelMessage array, not a string
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system[0].role).toBe('system');
    expect(callArgs.system[0].content).toBe('Cached rules');
    expect(callArgs.system[0].providerOptions.anthropic.cacheControl.type).toBe('ephemeral');
    expect(callArgs.system[1].role).toBe('system');
    expect(callArgs.system[1].content).toBe('Team context');
  });
});

// ── No claude-agent-sdk import ────────────────────────────────────────────

describe('ai-engine.ts has no claude-agent-sdk import', () => {
  it('does not import from @anthropic-ai/claude-agent-sdk', () => {
    const source = readFileSync(
      join(__dirname, 'ai-engine.ts'),
      'utf-8',
    );
    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
