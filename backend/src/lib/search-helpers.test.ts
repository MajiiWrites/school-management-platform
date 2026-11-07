/**
 * FINAL REBUILD Point 3 — frontend live-search helpers (pure functions
 * in frontend/src/lib/search.ts, imported here so they run under the
 * backend vitest suite; the frontend has no test runner of its own).
 * highlightMatches: case-insensitive substring segments for <mark>
 * highlighting; Urdu works (no case to fold). Debounce behaviour itself
 * lives in useDebouncedValue (~200 ms, LIVE_SEARCH_DEBOUNCE_MS) and is
 * exercised by the component contract, not a DOM test.
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — TS6059: this test intentionally imports a pure helper from
// the frontend tree (outside backend rootDir); vitest resolves it fine and
// the frontend build type-checks the helper itself.
import { highlightMatches, LIVE_SEARCH_DEBOUNCE_MS } from '../../../frontend/src/lib/search';

describe('highlightMatches', () => {
  it('marks the matched letters, case-insensitively', () => {
    expect(highlightMatches('Ahmed Raza', 'ahm')).toEqual([
      { text: 'Ahm', match: true },
      { text: 'ed Raza', match: false },
    ]);
    expect(highlightMatches('Ahmed Raza', 'AHMED')).toEqual([
      { text: 'Ahmed', match: true },
      { text: ' Raza', match: false },
    ]);
  });

  it('matches in the middle of the text and multiple times', () => {
    expect(highlightMatches('Bilal Khan', 'al')).toEqual([
      { text: 'Bil', match: false },
      { text: 'al', match: true },
      { text: ' Khan', match: false },
    ]);
    expect(highlightMatches('Sara Sara', 'sara')).toEqual([
      { text: 'Sara', match: true },
      { text: ' ', match: false },
      { text: 'Sara', match: true },
    ]);
  });

  it('matches Urdu substrings', () => {
    expect(highlightMatches('احمد رضا', 'احم')).toEqual([
      { text: 'احم', match: true },
      { text: 'د رضا', match: false },
    ]);
  });

  it('returns the whole text unmarked when there is no match', () => {
    expect(highlightMatches('Bilal Khan', 'zzz')).toEqual([{ text: 'Bilal Khan', match: false }]);
  });

  it('returns the whole text unmarked for an empty query or empty text', () => {
    expect(highlightMatches('Bilal Khan', '')).toEqual([{ text: 'Bilal Khan', match: false }]);
    expect(highlightMatches('Bilal Khan', '   ')).toEqual([{ text: 'Bilal Khan', match: false }]);
    expect(highlightMatches('', 'ahm')).toEqual([{ text: '', match: false }]);
  });

  it('matches admission numbers and roll-number text', () => {
    expect(highlightMatches('ADM-102', 'adm-10')).toEqual([
      { text: 'ADM-10', match: true },
      { text: '2', match: false },
    ]);
  });
});

describe('live-search debounce constant', () => {
  it('is ~200 ms (fast, live feel without a request per keystroke)', () => {
    expect(LIVE_SEARCH_DEBOUNCE_MS).toBe(200);
  });
});
