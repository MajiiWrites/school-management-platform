// Shared bits for the Platform Admin panel — typed confirmation
// (destructive actions) + the API error text helper used by every tab.
import { useState } from 'react';
import { ApiClientError } from '../../lib/api';
import { Button, Modal, inputCls } from '../../components/ui';

export function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/**
 * Typed confirmation: the confirm button stays disabled until the
 * admin types the exact expected value (school name, or
 * "entity:entityId"). The typed value is what the caller sends as the
 * backend `confirm` field — never a boolean.
 */
export function TypedConfirmDialog({
  open,
  title,
  message,
  expected,
  inputLabel,
  confirmLabel = 'Delete',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  expected: string;
  inputLabel: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  if (!open) return null;
  const matches = typed === expected;
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="text-sm text-slate-700">{message}</p>
      <label className="mt-4 block">
        <span className="mb-1 block text-sm font-medium text-slate-700">{inputLabel}</span>
        <input
          className={inputCls}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={expected}
          autoComplete="off"
          aria-label={inputLabel}
        />
      </label>
      <p className="mt-1 text-xs text-slate-500">
        Type the exact text to confirm — the button stays disabled until it matches.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" disabled={busy || !matches} onClick={() => onConfirm(typed)}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

/** Render a flat record value in a read-only table cell. */
export function cellValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Column keys for a read-only data table: the union of the first rows'
 * scalar keys, in first-seen order, capped so the table stays readable. */
export function columnsFor(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  for (const r of rows.slice(0, 5)) {
    for (const k of Object.keys(r)) {
      if (!cols.includes(k) && k !== 'id') cols.push(k);
      if (cols.length >= 8) return cols;
    }
  }
  return cols;
}
