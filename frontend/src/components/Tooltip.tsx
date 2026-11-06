import { useEffect, useRef, useState } from 'react';

/**
 * P8-TOUR: tiny "?" tooltip for confusing labels (dedupe key, voucher,
 * arrears, sibling discount, scheduled message, recycle bin, …).
 *
 * A plain `title` attribute is the hover fallback; tapping the "?" opens a
 * small bubble so it also works on touch screens, where hover does not
 * exist. The bubble is plain text inside a relative wrapper — no
 * positioning library, no DOM measuring, nothing that can break the page.
 * Keep the text to one or two short sentences, in plain words.
 *
 * Usage:
 *   <p>Arrears <Tooltip text="Unpaid fee from earlier months." /></p>
 */
export default function Tooltip({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  return (
    <span ref={ref} className="relative inline-block align-middle">
      <button
        type="button"
        title={text}
        aria-label={label ?? 'What does this mean?'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white text-xs font-bold text-brand-700 hover:bg-brand-50"
      >
        ?
      </button>
      {open && (
        <span className="absolute left-0 top-full z-30 mt-1 w-64 max-w-[80vw] rounded-lg border border-slate-200 bg-white p-3 text-left text-xs font-normal leading-relaxed text-slate-700 shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}
