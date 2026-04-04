/**
 * Topic Classifier — routes messages to conversation topics.
 *
 * 5 decision branches:
 * 1. 0 active + 0 idle → new topic (no LLM)
 * 2. 0 active + idle exist → lightweight generateText to match
 * 3. 1 active → return that topic (no LLM)
 * 4. 2+ active → generateText classification
 * 5. At cap (5) + classifier says new → reject
 */
import { generateText, type LanguageModel } from 'ai';
import type { TopicEntry } from '../domain/types.js';
import { safeJsonParse } from '../domain/safe-json.js';

export const MAX_ACTIVE_TOPICS = 5;

export interface ClassifyResult {
  readonly topicId: string | null;
  readonly topicName?: string;
  readonly confidence: number;
}

export interface TopicClassifierDeps {
  readonly model: LanguageModel;
  readonly activeTopics: TopicEntry[];
  readonly idleTopics: TopicEntry[];
  readonly messageContent: string;
}

function buildPrompt(topics: TopicEntry[], messageContent: string): string {
  const list = topics.map((t) => `- ${t.id}: "${t.name}"`).join('\n');
  return [
    'You are a topic classifier. Given the user\'s message and existing topics, determine which topic this message belongs to. Respond with ONLY a JSON object.',
    '',
    'Topics:',
    list,
    '',
    `User message: "${messageContent}"`,
    '',
    'Respond: {"topicId": "<id>"} to route to existing topic, or {"topicId": "new", "topicName": "<short name>"} to create new.',
  ].join('\n');
}

interface LlmResponse {
  topicId: string;
  topicName?: string;
}

function parseResponse(text: string, knownIds: Set<string>): ClassifyResult {
  const parsed = safeJsonParse<LlmResponse>(text, 'topic-classifier');
  if (!parsed?.topicId) return { topicId: null, topicName: undefined, confidence: 0.5 };
  if (parsed.topicId === 'new') return { topicId: null, topicName: parsed.topicName, confidence: 0.8 };
  if (knownIds.has(parsed.topicId)) return { topicId: parsed.topicId, confidence: 0.9 };
  return { topicId: null, topicName: undefined, confidence: 0.5 };
}

export async function classifyTopic(deps: TopicClassifierDeps): Promise<ClassifyResult> {
  const { model, activeTopics, idleTopics, messageContent } = deps;
  const hasActive = activeTopics.length > 0;
  const hasIdle = idleTopics.length > 0;

  // Branch 1: no topics at all → new topic
  if (!hasActive && !hasIdle) return { topicId: null, confidence: 1.0 };

  // Branch 3: exactly 1 active → route there
  if (activeTopics.length === 1 && !hasIdle) return { topicId: activeTopics[0].id, confidence: 1.0 };

  // Branch 2 & 4: LLM classification
  const candidates = hasActive ? activeTopics : idleTopics;
  const knownIds = new Set(candidates.map((t) => t.id));
  const prompt = buildPrompt(candidates, messageContent);

  const { text } = await generateText({ model, prompt, maxOutputTokens: 200 });
  const result = parseResponse(text, knownIds);

  // Branch 5: at cap + classifier says new → reject
  if (result.topicId === null && activeTopics.length >= MAX_ACTIVE_TOPICS) {
    return { topicId: null, topicName: undefined, confidence: 0 };
  }

  return result;
}
