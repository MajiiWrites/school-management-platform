/**
 * Change History page (D1, admin only).
 *
 * The backend writes one change_logs row per changed field on every edit
 * (GET /change-logs, newest first): who changed what, old value → new
 * value, when. The Phase 9 inspection found no UI for it anywhere — this
 * page is that UI. Filters: entity + record id (the two filters the API
 * supports), paginated.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ChangeLogEntry, PageResult } from '../lib/types';
import { fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, Tabs, useToast } from '../components/ui';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/** Entity filter tabs → the `entity` values the API stores. */
const ENTITY_FILTERS = [
  { key: 'all', label: 'All changes' },
  { key: 'student', label: 'Students' },
  { key: 'class', label: 'Classes' },
  { key: 'fee_record', label: 'Fees' },
  { key: 'result', label: 'Results' },
  { key: 'exam', label: 'Exams' },
  { key: 'school_settings', label: 'Settings' },
  { key: 'academic_session', label: 'Sessions' },
  { key: 'staff', label: 'Staff' },
  { key: 'fee_structure', label: 'Fee structures' },
] as const;

function showValue(v: string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  return v;
}

export default function ChangeHistoryPage() {
  const { push, view } = useToast();
  const [entity, setEntity] = useState<string>('all');
  const [entityId, setEntityId] = useState('');
  const [appliedEntityId, setAppliedEntityId] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ChangeLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (entity !== 'all') params.set('entity', entity);
      if (appliedEntityId.trim()) params.set('entity_id', appliedEntityId.trim());
      const data = await api<PageResult<ChangeLogEntry>>(`/change-logs?${params.toString()}`);
      setRows(data.items);
      setTotal(data.total);
      setPages(data.pages);
    } catch (err) {
      setError(errText(err));
      push('error', errText(err));
    } finally {
      setLoading(false);
    }
  }, [entity, appliedEntityId, page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  const applyRecordFilter = (e: FormEvent) => {
    e.preventDefault();
    setAppliedEntityId(entityId.trim());
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Change History</h1>
        <p className="text-sm text-slate-500">
          Every edit in the school, newest first — who changed what, the old value and the new value.
        </p>
      </div>

      <Tabs
        tabs={ENTITY_FILTERS.map((f) => ({ key: f.key, label: f.label }))}
        active={entity}
        onChange={(k) => {
          setEntity(k);
          setPage(1);
        }}
      />

      <form onSubmit={applyRecordFilter} className="flex flex-wrap items-end gap-2">
        <Field label="Record ID (optional — filter to one student, class, …)">
          <input
            className={`${inputCls} w-80 max-w-full`}
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="Paste a record ID to see only its changes"
            autoComplete="off"
          />
        </Field>
        <Button type="submit">Filter</Button>
        {appliedEntityId && (
          <Button
            variant="secondary"
            onClick={() => {
              setEntityId('');
              setAppliedEntityId('');
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {loading ? (
        <Spinner label="Loading change history…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No changes found"
          body={
            appliedEntityId || entity !== 'all'
              ? 'Nothing matches these filters — try clearing them.'
              : 'No edits have been recorded yet. Edits to students, classes, fees and results will show up here.'
          }
        />
      ) : (
        <>
          <p className="text-sm text-slate-500">
            {total} change{total === 1 ? '' : 's'} · Page {page} of {pages}
          </p>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Who</th>
                  <th className="px-4 py-3 font-medium">Record</th>
                  <th className="px-4 py-3 font-medium">Field</th>
                  <th className="px-4 py-3 font-medium">Old → New</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDateTime(r.changed_at)}</td>
                    <td className="px-4 py-3">
                      {r.actor_email ? (
                        <span className="break-all text-slate-800">{r.actor_email}</span>
                      ) : (
                        <>
                          <Badge tone="slate">{r.actor_type}</Badge>
                          <span className="ml-2 break-all text-xs text-slate-500">
                            {r.actor_id ? r.actor_id.slice(0, 8) : '—'}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-slate-800">{r.entity}</span>
                      <span className="ml-2 break-all text-xs text-slate-500">
                        {r.entity_id ? r.entity_id.slice(0, 8) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.field}</td>
                    <td className="px-4 py-3 text-slate-700">
                      <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{showValue(r.old_value)}</span>
                      {' → '}
                      <span className="rounded bg-brand-50 px-1.5 py-0.5 text-brand-700">{showValue(r.new_value)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="flex items-center justify-between">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              ← Previous
            </Button>
            <span className="text-sm text-slate-500">
              Page {page} of {pages}
            </span>
            <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
              Next →
            </Button>
          </div>
        </>
      )}
      {view}
    </div>
  );
}
