// FINAL REBUILD Point 3 — live search helpers (pure, no React import,
// so they are unit-testable without a DOM).
//
// highlightMatches splits a display string into { text, match } segments
// for one case-insensitive substring query. Urdu has no case, so
// toLowerCase() is a no-op there and the substring match just works.
// The component renders matched segments inside <mark> — never via
// innerHTML, so a query can never inject markup.

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function highlightMatches(text: string, query: string): HighlightSegment[] {
  const q = query.trim();
  if (!q || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const segments: HighlightSegment[] = [];
  let from = 0;
  let at = lower.indexOf(needle, from);
  if (at === -1) return [{ text, match: false }];
  while (at !== -1) {
    if (at > from) segments.push({ text: text.slice(from, at), match: false });
    segments.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments;
}

/** Live-search debounce delay (ms). ~200 ms: fast enough to feel live,
 * slow enough that a fast typist fires ~1 request per word, not per key. */
export const LIVE_SEARCH_DEBOUNCE_MS = 200;
