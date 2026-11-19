// College Mode — Programs list (college-only). Create / edit / delete
// with confirm; a 409 (semesters or enrollments exist) surfaces the
// API's own message, never a generic one.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { collegeApi, ApiClientError } from '../lib/api';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { LIVE_SEARCH_DEBOUNCE_MS } from '../lib/search';
import LiveSearchInput from '../components/LiveSearchInput';
import type { CollegeProgram } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export default function CollegeProgramsPage() {
  const [programs, setPrograms] = useState<CollegeProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, LIVE_SEARCH_DEBOUNCE_MS);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CollegeProgram | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CollegeProgram | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    collegeApi
      .listPrograms()
      .then((d) => {
        setPrograms(d.programs);
        setError('');
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return programs;
    return programs.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.department.toLowerCase().includes(q),
    );
  }, [programs, debouncedSearch]);

  const remove = async (p: CollegeProgram) => {
    try {
      await collegeApi.deleteProgram(p.id);
      push('success', 'Program deleted.');
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  if (loading) return <Spinner label="Loading programs…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Programs</h1>
          <p className="text-sm text-slate-500">Degree programs, their semesters, courses and toppers.</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          + Add program
        </Button>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {programs.length > 0 && (
        <LiveSearchInput value={search} onChange={setSearch} placeholder="Search programs by name, code or department…" ariaLabel="Search programs" />
      )}
      {programs.length === 0 && !error ? (
        <EmptyState
          title="No programs yet"
          body="Add your first degree program, then add its semesters and courses."
          actionLabel="Add your first program"
          onAction={() => {
            setEditing(null);
            setShowForm(true);
          }}
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No program found" body={`No program matches "${debouncedSearch.trim()}".`} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <Card key={p.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{p.name}</h2>
                  <p className="text-sm text-slate-500">
                    {p.code} · {p.department}
                  </p>
                </div>
                <Badge tone="blue">{p.duration_years} yrs</Badge>
              </div>
              <p className="mt-3 text-sm text-slate-600">
                {p.semester_count} semester{p.semester_count === 1 ? '' : 's'} · {p.student_count} student
                {p.student_count === 1 ? '' : 's'}
              </p>
              <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
                <Link to={`/college/programs/${p.id}`} className="flex-1 rounded-lg bg-brand-700 px-3 py-2 text-center text-sm font-medium text-white hover:bg-brand-900">
                  Semesters & students
                </Link>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing(p);
                    setShowForm(true);
                  }}
                >
                  Edit
                </Button>
                <Button variant="danger" onClick={() => setPendingDelete(p)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this program?"
        message={
          pendingDelete
            ? `Are you sure? This will delete ${pendingDelete.name} (${pendingDelete.code}). Deleting is blocked while the program still has semesters or enrollments.`
            : ''
        }
        confirmLabel="Delete program"
        tone="danger"
        onConfirm={() => {
          const p = pendingDelete;
          setPendingDelete(null);
          if (p) remove(p);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {showForm && (
        <ProgramForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            push('success', editing ? 'Program updated.' : 'Program created.');
            load();
          }}
        />
      )}
      {view}
    </div>
  );
}

function ProgramForm({ initial, onClose, onSaved }: { initial: CollegeProgram | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [department, setDepartment] = useState(initial?.department ?? '');
  const [durationYears, setDurationYears] = useState(initial?.duration_years ?? 4);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setConfirming(true);
  };

  const doSave = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const body = { name: name.trim(), code: code.trim(), department: department.trim(), duration_years: durationYears };
      if (initial) await collegeApi.updateProgram(initial.id, body);
      else await collegeApi.createProgram(body);
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add program'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <Field label="Program name">
          <input className={inputCls} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BS Computer Science" autoComplete="off" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code">
            <input className={inputCls} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. BSCS" autoComplete="off" />
          </Field>
          <Field label="Duration (years)">
            <input className={inputCls} required type="number" min={1} max={6} value={durationYears} onChange={(e) => setDurationYears(Number(e.target.value))} autoComplete="off" />
          </Field>
        </div>
        <Field label="Department">
          <input className={inputCls} required value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Computer Science" autoComplete="off" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save program'}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={initial ? `Update ${initial.name}?` : 'Add this program?'}
        message={initial ? `Are you sure? This will update ${initial.name} (${initial.code}).` : `Are you sure? This will add a new program: ${name.trim() || '—'} (${code.trim() || '—'}).`}
        confirmLabel={initial ? 'Update program' : 'Add program'}
        tone="primary"
        busy={busy}
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
}
