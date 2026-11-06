import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { PageResult, Student } from '../lib/types';
import { normalizePkPhone } from '../lib/utils';
import { Badge, Button, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, Tabs, useToast } from '../components/ui';
import type { FormEvent } from 'react';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export default function ParentsPage() {
  const [flag, setFlag] = useState<'missing' | 'invalid' | 'duplicate'>('missing');
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Student | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    api<PageResult<Student>>(`/parents?flag=${flag}&limit=200`)
      .then((d) => {
        setStudents(d.items);
        setError('');
      })
      .catch(() => setError('Could not load parent numbers.'))
      .finally(() => setLoading(false));
  }, [flag]);

  useEffect(load, [load]);

  const flagLabel: Record<string, string> = {
    missing: 'Missing number',
    invalid: 'Invalid number',
    duplicate: 'Duplicate number',
  };

  if (loading) return <Spinner label="Loading parent numbers…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Parents & phone numbers</h1>
        <p className="text-sm text-slate-500">
          Absent alerts and fee reminders can only reach parents with a valid number. Fix the flagged students below —
          numbers are stored encrypted and shown masked everywhere else.
        </p>
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}

      <Tabs
        tabs={[
          { key: 'missing', label: 'Missing number' },
          { key: 'invalid', label: 'Invalid number' },
          { key: 'duplicate', label: 'Duplicate number' },
        ]}
        active={flag}
        onChange={(k) => setFlag(k as typeof flag)}
      />

      {students.length === 0 ? (
        <EmptyState title={`No students with a ${flag} phone issue`} body="All parent numbers in this category look fine." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Class</th>
                <th className="px-4 py-3">Parent</th>
                <th className="px-4 py-3">Phone on file</th>
                <th className="px-4 py-3">Issue</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {students.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-900">{s.name}</td>
                  <td className="px-4 py-2.5">{s.class_name ?? '—'}</td>
                  <td className="px-4 py-2.5">{s.parent_name ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{s.parent_phone ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={flag === 'missing' ? 'red' : 'amber'}>{flagLabel[flag]}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button variant="secondary" onClick={() => setEditing(s)}>Fix number</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ParentFixModal
          student={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            push('success', 'Parent number updated.');
            load();
          }}
        />
      )}
      {view}
    </div>
  );
}

function ParentFixModal({
  student,
  onClose,
  onSaved,
}: {
  student: Student;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [parentName, setParentName] = useState(student.parent_name ?? '');
  const [phone, setPhone] = useState(student.parent_phone ?? '');
  const [optOut, setOptOut] = useState(student.parent_opt_out ?? false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (phone.trim() && !normalizePkPhone(phone.trim())) {
      setError('That number is not a valid Pakistani mobile (e.g. 03001234567).');
      return;
    }
    setBusy(true);
    try {
      await api(`/students/${student.id}/parent`, {
        method: 'PATCH',
        body: { parent_name: parentName.trim(), parent_phone: phone.trim() || undefined, opt_out: optOut },
      });
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Fix parent number — ${student.name}`} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Parent / guardian name">
          <input className={inputCls} value={parentName} onChange={(e) => setParentName(e.target.value)} />
        </Field>
        <Field label="Parent phone" hint="Pakistan mobile — 0300…, +92…, or 92…">
          <input className={inputCls} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="03001234567" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} />
          Parent opted out of SMS (never message this number)
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}
