/**
 * Memory search — hybrid keyword + vector search with temporal decay and MMR.
 *
 * Pipeline:
 *   Stage 1 — FTS5 keyword search with BM25 score normalization
 *   Stage 2 — Vector similarity via embedding cache (when embeddingFn provided)
 *   Stage 3 — Hybrid merge: 0.7 * vector + 0.3 * keyword (or keyword-only fallback)
 *   Stage 4 — Temporal decay (half-life = 30 days, skipped for identity/lesson)
 *   Stage 5 — MMR re-ranking (Jaccard similarity, λ = 0.7)
 */

import type Database from 'better-sqlite3';
import type { MemorySearchResult, MemoryType } from '../../domain/types.js';

// ── Types ───────────────────────────────────────────────────────────────────

interface FtsRow {
  id: number;
  chunk_content: string;
  content_hash: string;
  memory_id: number;
  key: string;
  type: string;
  updated_at: string;
  rank: number;
}

interface ChunkRow {
  id: number;
  chunk_content: string;
  content_hash: string;
}

interface CacheRow {
  embedding: Buffer;
  model: string;
}

interface ScoredCandidate {
  key: string;
  snippet: string;
  score: number;
  type: MemoryType;
  tokens: Set<string>;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** FTS5 special characters that must be stripped from user queries. */
const FTS5_SPECIAL_CHARS = /[*"()+\-^:]/g;

/** FTS5 reserved words that would break the MATCH expression. */
const FTS5_RESERVED_WORDS = new Set(['NEAR', 'NOT', 'AND', 'OR']);

/** Types exempt from temporal decay (timeless knowledge). */
const TIMELESS_TYPES = new Set(['identity', 'lesson']);

/** Temporal decay half-life in days. Score halves every 30 days. */
const DECAY_HALF_LIFE_DAYS = 30;

/** MMR diversity weight. Higher = more relevance, lower = more diversity. */
const MMR_LAMBDA = 0.7;

/** Maximum snippet length in characters. */
const MAX_SNIPPET_LENGTH = 500;

const MS_PER_DAY = 86_400_000;

// ── Query sanitization ──────────────────────────────────────────────────────

/** Strip FTS5 special characters and reserved words from a user query. */
function sanitizeQuery(raw: string): string {
  const stripped = raw.replace(FTS5_SPECIAL_CHARS, ' ').trim();
  const words = stripped
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FTS5_RESERVED_WORDS.has(w.toUpperCase()));
  return words.join(' ');
}

// ── Score normalization ─────────────────────────────────────────────────────

/** Normalize FTS5 BM25 ranks to 0–1. More negative rank = better match. */
function normalizeScores(rows: FtsRow[]): number[] {
  if (rows.length === 0) return [];
  if (rows.length === 1) return [1.0];

  const absMin = Math.abs(Math.min(...rows.map((r) => r.rank)));
  if (absMin === 0) return rows.map(() => 1.0);
  return rows.map((r) => 1 + r.rank / absMin);
}

// ── Temporal decay ──────────────────────────────────────────────────────────

/** Apply temporal decay. Identity and lesson types are exempt. */
function applyDecay(score: number, type: string, updatedAt: string): number {
  if (TIMELESS_TYPES.has(type)) return score;

  const daysSinceUpdate = (Date.now() - Date.parse(updatedAt)) / MS_PER_DAY;
  return score * Math.pow(0.5, daysSinceUpdate / DECAY_HALF_LIFE_DAYS);
}

// ── MMR helpers ─────────────────────────────────────────────────────────────

/** Tokenize text into a set of lowercase whitespace-split words. */
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

/** Jaccard similarity: |A∩B| / |A∪B|. Returns 0 if both sets are empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const w of smaller) if (larger.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Cosine similarity between two vectors. Returns 0 if either norm is 0. */
function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** MMR re-ranking: balance relevance with diversity (Jaccard-based). */
function mmrRerank(candidates: ScoredCandidate[], maxResults: number): ScoredCandidate[] {
  if (candidates.length <= 1) return candidates.slice(0, maxResults);
  const selected: ScoredCandidate[] = [];
  const remaining = new Set(candidates.map((_, i) => i));

  for (let round = 0; round < maxResults && remaining.size > 0; round++) {
    let bestIdx = -1, bestMmr = -Infinity;
    for (const idx of remaining) {
      const c = candidates[idx];
      let maxSim = 0;
      for (const sel of selected) {
        const sim = jaccard(c.tokens, sel.tokens);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = MMR_LAMBDA * c.score - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = idx; }
    }
    if (bestIdx >= 0) { selected.push(candidates[bestIdx]); remaining.delete(bestIdx); }
  }
  return selected;
}

// ── Main search function ────────────────────────────────────────────────────

const FTS_QUERY = `
  SELECT mc.id, mc.chunk_content, mc.content_hash, mc.memory_id,
         m.key, m.type, m.updated_at, rank
  FROM memory_chunks_fts
  JOIN memory_chunks mc ON mc.id = memory_chunks_fts.rowid
  JOIN memories m ON m.id = mc.memory_id
  WHERE memory_chunks_fts MATCH ? AND m.team_name = ? AND m.is_active = 1
  ORDER BY rank
  LIMIT ?
`;

const CHUNKS_QUERY = `
  SELECT mc.id, mc.chunk_content, mc.content_hash
  FROM memory_chunks mc JOIN memories m ON m.id = mc.memory_id
  WHERE m.team_name = ? AND m.is_active = 1
`;

const CACHE_LOOKUP = `SELECT embedding, model FROM embedding_cache WHERE content_hash = ?`;

const CACHE_INSERT = `
  INSERT OR IGNORE INTO embedding_cache (content_hash, embedding, model, created_at)
  VALUES (?, ?, ?, ?)
`;

/**
 * Search memory using FTS5 keyword matching with optional vector similarity,
 * temporal decay, and MMR re-ranking for diversity.
 */
/** Compute vector similarity scores for all chunks using embedding cache. */
async function computeVectorScores(
  raw: Database.Database, teamName: string, query: string,
  embeddingFn: (text: string) => Promise<number[]>,
): Promise<Map<string, number> | undefined> {
  try {
    const queryVec = await embeddingFn(query);
    const allChunks = raw.prepare(CHUNKS_QUERY).all(teamName) as ChunkRow[];
    const stmtLookup = raw.prepare(CACHE_LOOKUP);
    const stmtInsert = raw.prepare(CACHE_INSERT);
    const scores = new Map<string, number>();

    for (const chunk of allChunks) {
      try {
        let vec: number[] | Float32Array;
        const cached = stmtLookup.get(chunk.content_hash) as CacheRow | undefined;
        if (cached) {
          const buf = cached.embedding;
          const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          if (f32.length !== queryVec.length) {
            console.warn(`embedding dimension mismatch for ${chunk.content_hash}: ${f32.length} vs ${queryVec.length}`);
            continue;
          }
          vec = f32;
        } else {
          vec = await embeddingFn(chunk.chunk_content);
          const buffer = Buffer.from(new Float32Array(vec).buffer);
          stmtInsert.run(chunk.content_hash, buffer, 'default', new Date().toISOString());
        }
        scores.set(chunk.content_hash, cosineSimilarity(queryVec, vec));
      } catch { /* skip chunk on embedding failure */ }
    }
    return scores.size > 0 ? scores : undefined;
  } catch (err) {
    console.warn('query embedding failed, falling back to keyword-only:', err);
    return undefined;
  }
}

export async function searchMemory(
  raw: Database.Database, teamName: string, query: string,
  maxResults: number, embeddingFn?: (text: string) => Promise<number[]>,
): Promise<MemorySearchResult[]> {
  const sanitized = sanitizeQuery(query);
  if (sanitized.length === 0) return [];

  const rows = raw.prepare(FTS_QUERY).all(sanitized, teamName, maxResults * 10) as FtsRow[];
  if (rows.length === 0) return [];

  const keywordScores = normalizeScores(rows);

  // Stage 2+3: Vector similarity + hybrid merge
  const vectorScores = embeddingFn
    ? await computeVectorScores(raw, teamName, query, embeddingFn)
    : undefined;

  const mergedScores = rows.map((row, i) => {
    if (!vectorScores) return keywordScores[i];
    const vs = vectorScores.get(row.content_hash) ?? 0;
    return 0.7 * vs + 0.3 * keywordScores[i];
  });

  // Stage 4: Temporal decay
  const candidates: ScoredCandidate[] = rows.map((row, i) => ({
    key: row.key,
    snippet: row.chunk_content.length > MAX_SNIPPET_LENGTH
      ? row.chunk_content.slice(0, MAX_SNIPPET_LENGTH) : row.chunk_content,
    score: applyDecay(mergedScores[i], row.type, row.updated_at),
    type: row.type as MemoryType,
    tokens: tokenize(row.chunk_content),
  }));

  // Stage 5: MMR re-ranking + dedup by key
  const mmrResults = mmrRerank(candidates, maxResults * 2);
  const byKey = new Map<string, ScoredCandidate>();
  for (const item of mmrResults) {
    const existing = byKey.get(item.key);
    if (!existing || item.score > existing.score) byKey.set(item.key, item);
  }

  const source: 'hybrid' | 'keyword' = vectorScores ? 'hybrid' : 'keyword';
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((c) => ({
      key: c.key, snippet: c.snippet, score: c.score, type: c.type,
      is_active: true, source,
    }));
}
