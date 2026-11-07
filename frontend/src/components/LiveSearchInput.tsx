import { highlightMatches } from '../lib/search';
import { inputCls } from './ui';

// FINAL REBUILD Point 3 — shared live-search input (Classes + Students).
// No Search button, no reload: every keystroke updates the input
// instantly; the parent debounces (~200 ms) and fires the server query,
// cancelling the previous request with AbortController, so results never
// flicker or show stale data. `searching` shows a spinner while a
// debounced query is in flight; the × clears the query.

export function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = highlightMatches(text, query);
  return (
    <>
      {segments.map((s, i) =>
        s.match ? (
          <mark key={i} className="rounded-sm bg-yellow-200 px-0 text-inherit">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export default function LiveSearchInput({
  value,
  onChange,
  placeholder,
  searching,
  ariaLabel,
}: {
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
  searching?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="relative max-w-xs flex-1">
      <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
        🔍
      </span>
      <input
        type="search"
        role="searchbox"
        aria-label={ariaLabel ?? 'Search'}
        className={`${inputCls} pl-9 pr-8`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {searching ? (
        <span aria-label="Searching…" className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
          ⏳
        </span>
      ) : value ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          onClick={() => onChange('')}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
