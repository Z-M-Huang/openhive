/**
 * Memory search helpers: cosine similarity, temporal decay, MMR reranking.
 *
 * @module storage/stores/memory-search
 */

import type { MemoryEntry } from '../../domain/domain.js';

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Apply type-based temporal decay: curated = no decay, daily = 30-day half-life. */
export function applyDecayForEntry(entry: MemoryEntry, score: number): number {
  if (entry.memory_type === 'curated') return score; // No decay for curated
  const ageDays = (Date.now() - entry.created_at) / (24 * 60 * 60 * 1000);
  return score * Math.exp(-Math.LN2 / 30 * ageDays);
}

/** Apply temporal decay to a list of entries, re-sorting by decayed score. */
export function applyTemporalDecay(entries: MemoryEntry[]): MemoryEntry[] {
  const scored = entries.map((entry, i) => ({
    entry,
    score: applyDecayForEntry(entry, 1 - i / Math.max(entries.length, 1)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.entry);
}

/** MMR reranking for diversity. Lambda controls relevance vs diversity trade-off. */
export function mmrRerank(
  scored: Array<{ entry: MemoryEntry; score: number }>,
  _queryEmbedding: Float32Array,
  limit: number,
  lambda: number,
): Array<{ entry: MemoryEntry; score: number }> {
  if (scored.length <= limit) return scored;

  const selected: Array<{ entry: MemoryEntry; score: number }> = [];
  const remaining = [...scored];

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      // Max similarity to already selected (simple: use score overlap as proxy)
      let maxSim = 0;
      for (const s of selected) {
        // Content overlap as diversity proxy (avoids needing embeddings for all pairs)
        const overlap = contentOverlap(remaining[i].entry.content, s.entry.content);
        if (overlap > maxSim) maxSim = overlap;
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/** Simple word-overlap similarity for MMR diversity (avoids embedding dependency). */
function contentOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
