/**
 * Topic Classifier Tests — 5 decision branches.
 *
 * 1. 0 topics → null topicId, no LLM called
 * 2. 1 active → returns that topic's id, no LLM called
 * 3. 2+ active → calls generateText, routes correctly
 * 4. Max 5 active + classifier says new → reject (confidence 0)
 * 5. Idle topic match → returns idle topic's id
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanguageModel } from 'ai';
import type { TopicEntry } from '../domain/types.js';

// ── Hoisted mock for 'ai' module ─────────────────────────────────────────

const { mockGenerateText } = vi.hoisted(() => {
  const mockGenerateText = vi.fn();
  return { mockGenerateText };
});

vi.mock('ai', () => ({ generateText: mockGenerateText }));

import { classifyTopic, MAX_ACTIVE_TOPICS } from './topic-classifier.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const mockModel = { modelId: 'test', provider: 'test' } as unknown as LanguageModel;

function makeTopic(overrides: Partial<TopicEntry> & { id: string }): TopicEntry {
  return {
    channelId: 'ch-1',
    name: `Topic ${overrides.id}`,
    description: '',
    state: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    lastActivity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('classifyTopic', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns null topicId with no LLM call when 0 topics exist', async () => {
    const result = await classifyTopic({
      model: mockModel, activeTopics: [], idleTopics: [], messageContent: 'hello',
    });
    expect(result).toEqual({ topicId: null, confidence: 1.0 });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns the single active topic with no LLM call', async () => {
    const topic = makeTopic({ id: 't-1', name: 'Bug fix' });
    const result = await classifyTopic({
      model: mockModel, activeTopics: [topic], idleTopics: [], messageContent: 'update',
    });
    expect(result).toEqual({ topicId: 't-1', confidence: 1.0 });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('calls generateText and routes to matching topic with 2+ active', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"topicId": "t-2"}' });
    const topics = [
      makeTopic({ id: 't-1', name: 'Backend API' }),
      makeTopic({ id: 't-2', name: 'Frontend UI' }),
    ];
    const result = await classifyTopic({
      model: mockModel, activeTopics: topics, idleTopics: [], messageContent: 'fix the button',
    });
    expect(result.topicId).toBe('t-2');
    expect(result.confidence).toBe(0.9);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('rejects new topic when at max active cap', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"topicId": "new", "topicName": "Sixth"}' });
    const topics = Array.from({ length: MAX_ACTIVE_TOPICS }, (_, i) =>
      makeTopic({ id: `t-${i}`, name: `Topic ${i}` }),
    );
    const result = await classifyTopic({
      model: mockModel, activeTopics: topics, idleTopics: [], messageContent: 'new thing',
    });
    expect(result.topicId).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.topicName).toBeUndefined();
  });

  it('matches an idle topic via LLM when no active topics exist', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"topicId": "idle-1"}' });
    const idle = makeTopic({ id: 'idle-1', name: 'Old discussion', state: 'idle' });
    const result = await classifyTopic({
      model: mockModel, activeTopics: [], idleTopics: [idle], messageContent: 'resume discussion',
    });
    expect(result.topicId).toBe('idle-1');
    expect(result.confidence).toBe(0.9);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});
