/** Channel handler factory — topic classification/creation/reactivation before handleMessage(). */
import { randomBytes } from 'crypto';
import { handleMessage } from './sessions/message-handler.js';
import { classifyTopics, MAX_ACTIVE_TOPICS } from './sessions/topic-classifier.js';
import type { TopicSessionManager } from './sessions/topic-registry.js';
import { errorMessage } from './domain/errors.js';
import type { ChannelMessage, IInteractionStore, ITopicStore, ISenderTrustStore, ITrustAuditStore } from './domain/interfaces.js';
import type { TopicEntry } from './domain/types.js';
import type { ProgressUpdate } from './sessions/ai-engine.js';
import type { LanguageModel } from 'ai';
import type { TrustPolicy } from './config/trust-policy.js';
import { evaluateTrust } from './channels/trust-gate.js';

export interface TopicResult { readonly response: string; readonly topicId?: string; readonly topicName?: string }
export interface ChannelHandlerResult { readonly results: TopicResult[] }
export interface ChannelHandlerDeps {
  handlerDeps: Parameters<typeof handleMessage>[1] | null;
  triggerEngine: { onMessage(content: string, channelId: string): void };
  interactionStore?: IInteractionStore;
  topicStore?: ITopicStore;
  classifierModel?: LanguageModel;
  topicSessionManager?: TopicSessionManager;
  trustPolicy?: TrustPolicy;
  senderTrustStore?: ISenderTrustStore;
  trustAuditStore?: ITrustAuditStore;
}
type ChannelHandler = (msg: ChannelMessage, onProgress?: (u: ProgressUpdate) => void) => Promise<ChannelHandlerResult>;

// Per-channel mutex preventing classify-then-create race (R-2).
const channelLocks = new Map<string, Promise<unknown>>();
function withChannelLock<T>(ch: string, fn: () => Promise<T>): Promise<T> {
  const prev = channelLocks.get(ch) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const safe = next.catch(() => {});
  channelLocks.set(ch, safe);
  void safe.then(() => { if (channelLocks.get(ch) === safe) channelLocks.delete(ch); });
  return next;
}

function chType(id: string): string {
  return id === 'cli' ? 'cli' : id.startsWith('ws:') ? 'ws' : id.startsWith('discord:') ? 'discord' : 'other';
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

/** Resolve one or more topics: hint match -> fast path -> LLM multi-classify -> create. */
async function resolveTopics(
  msg: ChannelMessage, store: ITopicStore, model?: LanguageModel,
): Promise<Array<{ topicId: string; topicName: string }>> {
  const active = store.getActiveByChannel(msg.channelId);
  const idle = store.getIdleByChannel(msg.channelId);
  const all = [...active, ...idle];

  if (msg.topicHint) {
    const hint = msg.topicHint.toLowerCase();
    const match = all.find((t) => t.name.toLowerCase() === hint);
    return [match ? useExisting(store, match) : newTopic(store, msg.channelId, msg.topicHint)];
  }
  if (all.length === 0) return [newTopic(store, msg.channelId)];
  if (active.length === 1 && idle.length === 0) return [useExisting(store, active[0])];
  if (!model) return [active.length > 0 ? useExisting(store, active[0]) : newTopic(store, msg.channelId)];

  const result = await classifyTopics({ model, activeTopics: active, idleTopics: idle, messageContent: msg.content });

  const resolved: Array<{ topicId: string; topicName: string }> = [];
  for (const match of result.matches) {
    if (match.topicId === null) {
      if (active.length >= MAX_ACTIVE_TOPICS) {
        const names = active.map((t: TopicEntry) => `• ${t.name}`).join('\n');
        throw new Error(`Max ${MAX_ACTIVE_TOPICS} active topics reached. Active topics:\n${names}`);
      }
      resolved.push(newTopic(store, msg.channelId, match.topicName));
    } else {
      const matched = all.find((t) => t.id === match.topicId);
      if (matched) resolved.push(useExisting(store, matched));
    }
  }
  return resolved.length > 0 ? resolved : [newTopic(store, msg.channelId)];
}

/** Factory: creates a channel handler closing over shared deps. */
export function createChannelHandler(deps: ChannelHandlerDeps): ChannelHandler {
  const { handlerDeps, triggerEngine, interactionStore, topicStore, classifierModel, topicSessionManager } = deps;
  return async (msg, onProgress?) => {
    const ct = chType(msg.channelId);

    // ── TrustGate: evaluate before trigger engine (AC-11) ─────────────
    const trustResult = evaluateTrust({
      channelType: ct,
      channelId: msg.channelId,
      senderId: msg.userId,
      trustPolicy: deps.trustPolicy,
      senderTrustStore: deps.senderTrustStore,
    });

    if (trustResult.decision !== 'allow') {
      const auditDecision = 'denied';
      try {
        deps.trustAuditStore?.log({
          channelType: ct, channelId: msg.channelId, senderId: msg.userId,
          decision: auditDecision, reason: trustResult.reason, createdAt: new Date().toISOString(),
        });
      } catch { /* must not crash */ }
      try {
        interactionStore?.log({
          direction: 'inbound', channelType: ct, channelId: msg.channelId,
          userId: msg.userId, contentSnippet: msg.content.slice(0, 2000),
          contentLength: msg.content.length, trustDecision: auditDecision,
        });
      } catch { /* must not crash */ }

      if (trustResult.decision === 'deny_silent') {
        return { results: [] };
      }
      // deny_respond
      return { results: [{ response: 'Not authorized.' }] };
    }

    // Trust allowed — log audit
    try {
      deps.trustAuditStore?.log({
        channelType: ct, channelId: msg.channelId, senderId: msg.userId,
        decision: 'allowed', reason: trustResult.reason, createdAt: new Date().toISOString(),
      });
    } catch { /* must not crash */ }

    triggerEngine.onMessage(msg.content, msg.channelId);

    let topics: Array<{ topicId: string; topicName: string }> = [];
    if (topicStore) {
      try {
        topics = await withChannelLock(msg.channelId, () => resolveTopics(msg, topicStore, classifierModel));
      } catch (err) {
        return { results: [{ response: `Error: ${errorMessage(err)}` }] };
      }
    }

    if (!handlerDeps) {
      return { results: [{ response: 'No providers configured.', topicId: topics[0]?.topicId, topicName: topics[0]?.topicName }] };
    }

    // Process each topic — same-topic serialized, different topics parallel via TopicSessionManager
    const work = (topics.length > 0 ? topics : [{ topicId: undefined as string | undefined, topicName: undefined as string | undefined }])
      .map(({ topicId, topicName }) => {
        const run = async (): Promise<TopicResult> => {
          // Log inbound per-topic so topic-scoped history includes the user message
          try {
            interactionStore?.log({ direction: 'inbound', channelType: ct, channelId: msg.channelId,
              userId: msg.userId, contentSnippet: msg.content.slice(0, 2000), contentLength: msg.content.length, topicId, trustDecision: 'allowed' });
          } catch { /* must not crash */ }

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

        // Use TopicSessionManager for per-topic serialization when available
        if (topicSessionManager && topicId) {
          return topicSessionManager.enqueue(topicId, run);
        }
        return run();
      });

    const settled = await Promise.allSettled(work);
    const results: TopicResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const t = topics[i];
      return { response: `Error: ${errorMessage(s.reason)}`, topicId: t?.topicId, topicName: t?.topicName };
    });

    return { results };
  };
}
