/**
 * bm25 — a tiny, dependency-free Okapi BM25 ranker.
 *
 * Used to RETRIEVE the few most relevant turns from the elided middle of a
 * long conversation (4.5), so a question that echoes something said 20 turns
 * ago can still surface that turn instead of losing it to positional elision —
 * without injecting the whole history (token cost stays bounded).
 *
 * Pure functions, fully unit-tested. Bilingual tokenizer (Latin + Arabic).
 */

export interface Bm25Options {
  /** Term-frequency saturation. Higher = TF matters more. */
  k1?: number;
  /** Length normalisation. 0 = ignore length, 1 = full. */
  b?: number;
  /** Cap on returned results (highest score first). */
  limit?: number;
}

export interface RankedDoc {
  index: number;
  score: number;
}

// Match runs of Latin letters/digits OR Arabic-block characters. \b word
// boundaries don't apply to Arabic, so we match positively instead. Arabic
// ranges: 0600–06FF (main), 0750–077F (supplement), 08A0–08FF (extended-A),
// FB50–FDFF / FE70–FEFF (presentation forms).
const TOKEN_RE =
  /[a-z0-9]+|[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g;

// Arabic diacritics (tashkeel) — stripped so "كتاب" matches "كِتاب".
const TASHKEEL_RE = /[ً-ٰٟۖ-ۭ]/g;

export function tokenize(text: unknown): string[] {
  const s = String(text ?? "").toLowerCase().replace(TASHKEEL_RE, "");
  return s.match(TOKEN_RE) ?? [];
}

/**
 * Rank `docs` by BM25 relevance to `query`. Returns the matching docs
 * (score > 0) as {index, score}, highest first, capped at `limit`. Docs that
 * share no query term are omitted entirely.
 */
export function rankBM25(query: string, docs: string[], opts: Bm25Options = {}): RankedDoc[] {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || docs.length === 0) return [];

  const docTokens = docs.map(tokenize);
  const docLens = docTokens.map((t) => t.length);
  const N = docs.length;
  const avgdl = docLens.reduce((a, c) => a + c, 0) / N || 1;

  // Per-doc term-frequency maps + document frequency per query term.
  const tfMaps = docTokens.map((tokens) => {
    const m = new Map<string, number>();
    for (const tok of tokens) m.set(tok, (m.get(tok) ?? 0) + 1);
    return m;
  });
  const df = new Map<string, number>();
  for (const term of qTerms) {
    let n = 0;
    for (const m of tfMaps) if (m.has(term)) n++;
    df.set(term, n);
  }

  // Robertson–Sparck-Jones IDF, smoothed with +1 so it never goes negative
  // (a term present in every doc still contributes a little, not a penalty).
  const idf = new Map<string, number>();
  for (const term of qTerms) {
    const n = df.get(term) ?? 0;
    idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const ranked: RankedDoc[] = [];
  for (let i = 0; i < N; i++) {
    const tf = tfMaps[i];
    const len = docLens[i] ?? 0;
    let score = 0;
    for (const term of qTerms) {
      const f = tf?.get(term) ?? 0;
      if (f === 0) continue;
      const numerator = f * (k1 + 1);
      const denominator = f + k1 * (1 - b + (b * len) / avgdl);
      score += (idf.get(term) ?? 0) * (numerator / denominator);
    }
    if (score > 0) ranked.push({ index: i, score });
  }

  // Highest score first; ties broken by earlier index for determinism.
  ranked.sort((x, y) => y.score - x.score || x.index - y.index);
  return opts.limit != null ? ranked.slice(0, opts.limit) : ranked;
}
