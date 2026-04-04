/** Channel handler factory — topic classification/creation/reactivation before handleMessage(). */
import { randomBytes } from 'crypto';
import { handleMessage } from './sessions/message-handler.js';
import { classifyTopic, MAX_ACTIVE_TOPICS } from './sessions/topic-classifier.js';
import type { TopicSessionManager } from './sessions/topic-session-manager.js';
import { errorMessage } from './domain/errors.js';
import type { ChannelMessage, IInteractionStore, ITopicStore } from './domain/interfaces.js';
import type { TopicEntry } from './domain/types.js';
import type { ProgressUpdate } from './sessions/ai-engine.js';
import type { LanguageModel } from 'ai';

export interface ChannelHandlerResult { readonly response: string; readonly topicId?: string; readonly topicName?: string }
export interface ChannelHandlerDeps {
  handlerDeps: Parameters<typeof handleMessage>[1] | null;
  triggerEngine: { onMessage(content: string, channelId: string): void };
  interactionStore?: IInteractionStore;
  topicStore?: ITopicStore;
  classifierModel?: LanguageModel;
  topicSessionManager?: TopicSessionManager;
}
type ChannelHandler = (msg: ChannelMessage, onProgress?: (u: ProgressUpdate) => void) => Promise<ChannelHandlerResult>;

// Per-channel mutex preventing classify-then-create race (R-2).
const channelLocks = new Map<string, Promise<unknown>>();
function withChannelLock<T>(ch: string, fn: () => Promise<T>): Promise<T> {
  const prev = channelLocks.get(ch) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const safe = next.catch(() => {});
  channelLocks.set(ch, safe);
  safe.then(() => { if (channelLocks.get(ch) === safe) channelLocks.delete(ch); });
  return next;
}

function chType(id: string): string {
  return id.startsWith('ws:') ? 'ws' : id.startsWith('discord:') ? 'discord' : 'other';
}
function newTopic(s: ITopicStore, channelId: string, name?: string): { topicId: string; topicName: string } {
  const id = `t-${randomBytes(8).toString('hex')}`, topicName = name ?? 'New topic', now = new Date().toISOString();
  s.create({ id, channelId, name: topicName, description: '', state: 'active', createdAt: now, lastActivity: now });
  return { topicId: id, topicName };
}
function useExisting(s: ITopicStore, t: TopicEntry): { topicId: string; topicName: string } {
  if (t.state === 'idle') s.updateState(t.id, 'active');
  s.touchActivity(t.id);
  return { topicId: t.id, topicName: t.name };
}

/** Resolve topicId: hint match -> fast path -> LLM classify -> create. */
async function resolveTopic(msg: ChannelMessage, store: ITopicStore, model?: LanguageModel) {
  const active = store.getActiveByChannel(msg.channelId);
  const idle = store.getIdleByChannel(msg.channelId);
  const all = [...active, ...idle];
  if (msg.topicHint) {
    const hint = msg.topicHint.toLowerCase();
    const match = all.find((t) => t.name.toLowerCase() === hint);
    return match ? useExisting(store, match) : newTopic(store, msg.channelId, msg.topicHint);
  }
  if (all.length === 0) return newTopic(store, msg.channelId);
  if (active.length === 1 && idle.length === 0) return useExisting(store, active[0]);
  if (!model) return active.length > 0 ? useExisting(store, active[0]) : newTopic(store, msg.channelId);

  const result = await classifyTopic({ model, activeTopics: active, idleTopics: idle, messageContent: msg.content });
  if (result.topicId === null) {
    if (active.length >= MAX_ACTIVE_TOPICS) {
      const names = active.map((t: TopicEntry) => `• ${t.name}`).join('\n');
      throw new Error(`Max ${MAX_ACTIVE_TOPICS} active topics reached. Active topics:\n${names}`);
    }
    return newTopic(store, msg.channelId, result.topicName);
  }
  const matched = all.find((t) => t.id === result.topicId);
  if (matched) return useExisting(store, matched);
  store.touchActivity(result.topicId);
  return { topicId: result.topicId, topicName: 'Unknown' };
}

/** Factory: creates a channel handler closing over shared deps. */
export function createChannelHandler(deps: ChannelHandlerDeps): ChannelHandler {
  const { handlerDeps, triggerEngine, interactionStore, topicStore, classifierModel } = deps;
  return async (msg, onProgress?) => {
    triggerEngine.onMessage(msg.content, msg.channelId);
    let topicId: string | undefined, topicName: string | undefined;
    if (topicStore) {
      try {
        const r = await withChannelLock(msg.channelId, () => resolveTopic(msg, topicStore, classifierModel));
        topicId = r.topicId; topicName = r.topicName;
      } catch (err) {
        return { response: `Error: ${errorMessage(err)}` };
      }
    }
    const ct = chType(msg.channelId);
    try {
      interactionStore?.log({ direction: 'inbound', channelType: ct, channelId: msg.channelId,
        userId: msg.userId, contentSnippet: msg.content.slice(0, 2000), contentLength: msg.content.length, topicId });
    } catch { /* must not crash */ }
    if (!handlerDeps) return { response: 'No providers configured.', topicId, topicName };
    const result = await handleMessage(msg, handlerDeps, { onProgress, sourceChannelId: msg.channelId, topicId, topicName });
    const response = result.ok ? (result.content ?? '') : `Error: ${result.error}`;
    if (response) {
      try {
        interactionStore?.log({ direction: 'outbound', channelType: ct, channelId: msg.channelId,
          teamId: 'main', contentSnippet: response.slice(0, 2000), contentLength: response.length, topicId });
      } catch { /* must not crash */ }
    }
    return { response, topicId, topicName };
  };
}
