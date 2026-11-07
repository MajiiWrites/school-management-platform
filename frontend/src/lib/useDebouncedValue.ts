import { useEffect, useState } from 'react';

// FINAL REBUILD Point 3 — debounced value for live search. The input
// updates on every keystroke (value stays instant); the debounced value
// only changes ~200 ms after the user stops typing, and that is what
// fires the server query. Clearing the timeout on every change is what
// makes it a debounce, not a throttle.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
