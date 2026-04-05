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

const MARKDOWN_FENCE_RE = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;

function stripMarkdownFences(text: string): string {
  const match = MARKDOWN_FENCE_RE.exec(text);
  return match ? match[1] : text;
}

interface LlmResponse {
  topicId: string;
  topicName?: string;
}

function parseResponse(text: string, knownIds: Set<string>): ClassifyResult {
  const parsed = safeJsonParse<LlmResponse>(stripMarkdownFences(text), 'topic-classifier');
  if (!parsed?.topicId) return { topicId: null, topicName: undefined, confidence: 0.5 };
  if (parsed.topicId === 'new') return { topicId: null, topicName: parsed.topicName, confidence: 0.8 };
  if (knownIds.has(parsed.topicId)) return { topicId: parsed.topicId, confidence: 0.9 };
  return { topicId: null, topicName: undefined, confidence: 0.5 };
}

// ── Multi-topic classification ──────────────────────────────────────────

export interface MultiClassifyResult {
  readonly matches: ClassifyResult[];
}

function buildMultiPrompt(topics: TopicEntry[], messageContent: string): string {
  const list = topics.map((t) => `- ${t.id}: "${t.name}"`).join('\n');
  return [
    'You are a topic classifier. Given the user\'s message and existing topics, determine which topics this message is relevant to. A single message may relate to multiple topics. Respond with ONLY a JSON object.',
    '',
    'Topics:',
    list,
    '',
    `User message: "${messageContent}"`,
    '',
    'Respond: {"topicIds": ["<id1>", "<id2>"]} to route to one or more existing topics.',
    'If no existing topic matches, respond: {"topicIds": ["new"], "topicName": "<short name>"}.',
    'Do NOT include "new" alongside existing IDs.',
  ].join('\n');
}

interface MultiLlmResponse {
  topicIds: string[];
  topicName?: string;
}

function parseMultiResponse(text: string, knownIds: Set<string>): ClassifyResult[] {
  const parsed = safeJsonParse<MultiLlmResponse>(stripMarkdownFences(text), 'topic-classifier-multi');
  if (!parsed?.topicIds || !Array.isArray(parsed.topicIds) || parsed.topicIds.length === 0) {
    return [{ topicId: null, topicName: undefined, confidence: 0.5 }];
  }
  if (parsed.topicIds.length === 1 && parsed.topicIds[0] === 'new') {
    return [{ topicId: null, topicName: parsed.topicName, confidence: 0.8 }];
  }
  const seen = new Set<string>();
  const results = parsed.topicIds
    .filter((id) => knownIds.has(id) && !seen.has(id) && (seen.add(id), true))
    .map((id) => ({ topicId: id as string | null, confidence: 0.9 }));
  return results.length > 0
    ? results
    : [{ topicId: null, topicName: undefined, confidence: 0.5 }];
}

export async function classifyTopics(deps: TopicClassifierDeps): Promise<MultiClassifyResult> {
  const { model, activeTopics, idleTopics, messageContent } = deps;
  const hasActive = activeTopics.length > 0;
  const hasIdle = idleTopics.length > 0;

  if (!hasActive && !hasIdle) return { matches: [{ topicId: null, confidence: 1.0 }] };
  if (activeTopics.length === 1 && !hasIdle) return { matches: [{ topicId: activeTopics[0].id, confidence: 1.0 }] };

  const candidates = hasActive ? activeTopics : idleTopics;
  const knownIds = new Set(candidates.map((t) => t.id));
  const prompt = buildMultiPrompt(candidates, messageContent);

  const { text } = await generateText({ model, prompt, maxOutputTokens: 200 });
  const matches = parseMultiResponse(text, knownIds);

  if (matches.every((m) => m.topicId === null) && activeTopics.length >= MAX_ACTIVE_TOPICS) {
    return { matches: [{ topicId: null, topicName: undefined, confidence: 0 }] };
  }

  return { matches };
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
