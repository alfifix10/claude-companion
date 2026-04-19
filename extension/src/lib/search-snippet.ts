/**
 * search-snippet — context-aware highlight snippet for the history
 * overlay's full-text search.
 *
 * Given a message body and the user's query, returns HTML with the
 * first case-insensitive occurrence wrapped in `<mark>` and ~`windowChars`
 * of surrounding context on each side. Elision `…` indicates the
 * snippet was clipped.
 *
 * Pure function. The emitted HTML is safe — every user-originated
 * piece of text is HTML-escaped before concatenation, and the only
 * unescaped markup is our own trusted `<mark>` wrapper.
 *
 * Returns `null` when the query is missing or doesn't appear in the
 * text. Caller decides whether to render the result or skip.
 */

import { escapeHtml } from "./markdown";

export function buildSnippet(
  text: string | null | undefined,
  query: string | null | undefined,
  windowChars = 40,
): string | null {
  if (!text || !query) return null;

  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return null;

  const start = Math.max(0, idx - windowChars);
  const end = Math.min(text.length, idx + query.length + windowChars);

  const beforeText = (start > 0 ? "…" : "") + text.slice(start, idx);
  const hit = text.slice(idx, idx + query.length);
  const afterText = text.slice(idx + query.length, end) + (end < text.length ? "…" : "");

  return `${escapeHtml(beforeText)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(afterText)}`;
}
