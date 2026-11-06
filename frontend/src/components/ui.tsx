import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../lib/utils';

/* ---------- Buttons ---------- */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

export function Button({
  children,
  variant = 'primary',
  type = 'button',
  disabled,
  onClick,
  className,
  title,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  /** Native tooltip — used for disabled-state reasons. */
  title?: string;
}) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-brand-700 text-white hover:bg-brand-900 disabled:bg-slate-300',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    ghost: 'text-brand-700 hover:bg-brand-50 disabled:text-slate-400',
    success: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600',
        styles[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ---------- Cards & stats ---------- */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'slate',
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'slate' | 'green' | 'amber' | 'red';
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-900',
    green: 'text-brand-700',
    amber: 'text-amber-600',
    red: 'text-red-600',
  };
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx('mt-1 text-2xl font-bold', tones[tone])}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </Card>
  );
}

/* ---------- Badges ---------- */

type BadgeTone = 'green' | 'amber' | 'red' | 'slate' | 'blue';

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: BadgeTone }) {
  const tones: Record<BadgeTone, string> = {
    green: 'bg-brand-100 text-brand-700',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
    slate: 'bg-slate-100 text-slate-700',
    blue: 'bg-blue-100 text-blue-700',
  };
  return (
    <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

/* ---------- Form fields ---------- */

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-slate-100';

/* ---------- Modal ---------- */

export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Defence in depth: a Modal must never paint an empty shell. Every
  // call site guards the render on real content, but if one ever mounts
  // with no children (e.g. `{x && <Modal>…}` written the other way
  // round), render nothing instead of a stuck empty overlay that no
  // close action can dismiss.
  if (!children) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className={cx(
          'max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-xl leading-none text-slate-500 hover:bg-slate-100" aria-label="Close">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Loading / empty / error ---------- */

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-700" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
  actionHref,
}: {
  title: string;
  body?: string;
  /** Optional call-to-action button shown under the message (never a blank page). */
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {body ? <p className="mt-1 text-sm text-slate-500">{body}</p> : null}
      {actionLabel && onAction ? (
        <button
          onClick={onAction}
          className="mt-4 inline-block rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-900"
        >
          {actionLabel}
        </button>
      ) : null}
      {actionLabel && !onAction && actionHref ? (
        <a
          href={actionHref}
          className="mt-4 inline-block rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-900"
        >
          {actionLabel}
        </a>
      ) : null}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span>{message}</span>
      {onRetry ? (
        <button onClick={onRetry} className="shrink-0 font-medium underline">
          Retry
        </button>
      ) : null}
    </div>
  );
}

/* ---------- Toast ---------- */

export interface ToastItem {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = (kind: ToastItem['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  };
  const view = (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'pointer-events-auto rounded-lg px-4 py-3 text-sm font-medium text-white shadow-lg',
            t.kind === 'success' ? 'bg-brand-700' : 'bg-red-600',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
  return { push, view };
}

/* ---------- Tabs ---------- */

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
            active === t.key
              ? 'border-brand-700 text-brand-700'
              : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
