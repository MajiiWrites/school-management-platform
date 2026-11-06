import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import type { Student } from '../lib/types';
import { normalizePkPhone } from '../lib/utils';
import { Badge, Button, EmptyState, Field, inputCls, Modal, useToast } from '../components/ui';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

function phoneBadge(s: Student) {
  if (s.phone_flag === 'missing') return <Badge tone="red">No number</Badge>;
  if (s.phone_flag === 'invalid') return <Badge tone="amber">Invalid number</Badge>;
  if (s.phone_flag === 'duplicate') return <Badge tone="amber">Duplicate number</Badge>;
  return <Badge tone="green">OK</Badge>;
}

export default function StudentsPanel({
  classId,
  students,
  setStudents,
  showOcr,
  classNameLabel,
}: {
  classId: string;
  students: Student[];
  setStudents: (s: Student[]) => void;
  showOcr?: boolean;
  classNameLabel?: string;
}) {
  const [search, setSearch] = useState('');
  const [flagFilter, setFlagFilter] = useState<'all' | 'missing' | 'invalid' | 'duplicate'>('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { push, view } = useToast();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return students.filter((s) => {
      if (flagFilter !== 'all' && s.phone_flag !== flagFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        String(s.roll_no ?? '').includes(q) ||
        (s.parent_name ?? '').toLowerCase().includes(q)
      );
    });
  }, [students, search, flagFilter]);

  const remove = async (s: Student) => {
    if (!window.confirm(`Remove ${s.name} from this class?`)) return;
    try {
      await api(`/students/${s.id}`, { method: 'DELETE' });
      setStudents(students.filter((x) => x.id !== s.id));
      push('success', 'Student removed.');
    } catch (e) {
      push('error', errText(e));
    }
  };

  const importCsv = async (file: File) => {
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api<{ imported: number; duplicates_flagged: number; invalid_rows: number }>(
        `/classes/${classId}/students/import-csv`,
        { method: 'POST', body: form },
      );
      push('success', `Imported ${res.imported} students (${res.duplicates_flagged} duplicates flagged, ${res.invalid_rows} invalid rows).`);
      // Refresh list
      const fresh = await api<{ items: Student[] }>(`/classes/${classId}/students?limit=200`);
      setStudents(fresh.items);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} max-w-xs`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, roll no, parent…"
        />
        <select className={inputCls + ' w-auto'} value={flagFilter} onChange={(e) => setFlagFilter(e.target.value as typeof flagFilter)}>
          <option value="all">All phone statuses</option>
          <option value="missing">Missing number</option>
          <option value="invalid">Invalid number</option>
          <option value="duplicate">Duplicate number</option>
        </select>
        <div className="ml-auto flex flex-wrap gap-2">
          {showOcr && (
            <Link to={`/classes/${classId}/ocr`} className="rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-900">
              📷 Upload list photo (OCR)
            </Link>
          )}
          <Button
            variant="secondary"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? 'Importing…' : 'Import CSV / Excel'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importCsv(f);
              e.target.value = '';
            }}
          />
          <Button
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + Add student
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No students found"
          body={students.length === 0 ? `No students in ${classNameLabel ?? 'this class'} yet — upload a list photo or add them manually.` : 'Try a different search or filter.'}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Roll</th>
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Parent</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Phone status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium">{s.roll_no ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-900">{s.name}</span>
                    {s.name_ur ? <span className="urdu ml-2 text-slate-500">{s.name_ur}</span> : null}
                  </td>
                  <td className="px-4 py-2.5">{s.parent_name ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{s.parent_phone ?? '—'}</td>
                  <td className="px-4 py-2.5">{phoneBadge(s)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      className="mr-3 font-medium text-brand-700 hover:underline"
                      onClick={() => {
                        setEditing(s);
                        setShowForm(true);
                      }}
                    >
                      Edit
                    </button>
                    <button className="font-medium text-red-600 hover:underline" onClick={() => remove(s)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <StudentForm
          classId={classId}
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={(saved) => {
            setShowForm(false);
            if (editing) setStudents(students.map((x) => (x.id === saved.id ? saved : x)));
            else setStudents([...students, saved]);
            push('success', editing ? 'Student updated.' : 'Student added.');
          }}
        />
      )}
      {view}
    </div>
  );
}

function StudentForm({
  classId,
  initial,
  onClose,
  onSaved,
}: {
  classId: string;
  initial: Student | null;
  onClose: () => void;
  onSaved: (s: Student) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [nameUr, setNameUr] = useState(initial?.name_ur ?? '');
  const [rollNo, setRollNo] = useState(initial?.roll_no ? String(initial.roll_no) : '');
  const [parentName, setParentName] = useState(initial?.parent_name ?? '');
  const [parentPhone, setParentPhone] = useState(initial?.parent_phone ?? '');
  const [optOut, setOptOut] = useState(initial?.parent_opt_out ?? false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const phone = parentPhone.trim();
    if (phone && !normalizePkPhone(phone)) {
      setError('Parent phone looks invalid — use a Pakistani mobile like 03001234567.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        name_ur: nameUr.trim() || undefined,
        roll_no: rollNo ? Number(rollNo) : undefined,
        parent_name: parentName.trim() || undefined,
        parent_phone: phone || undefined,
        parent_opt_out: optOut,
      };
      let saved: Student;
      if (initial) {
        saved = await api<Student>(`/students/${initial.id}`, { method: 'PATCH', body });
      } else {
        saved = await api<Student>(`/classes/${classId}/students`, { method: 'POST', body });
      }
      onSaved(saved);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add student'} onClose={onClose}>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="Student name (English)">
              <input className={inputCls} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ahmed Raza" />
            </Field>
          </div>
          <Field label="Roll no.">
            <input className={inputCls} type="number" min={1} value={rollNo} onChange={(e) => setRollNo(e.target.value)} placeholder="1" />
          </Field>
        </div>
        <Field label="Name in Urdu (optional)">
          <input className={`${inputCls} urdu`} dir="rtl" value={nameUr} onChange={(e) => setNameUr(e.target.value)} placeholder="احمد رضا" />
        </Field>
        <Field label="Parent / guardian name">
          <input className={inputCls} value={parentName} onChange={(e) => setParentName(e.target.value)} placeholder="e.g. Muhammad Raza" />
        </Field>
        <Field label="Parent phone" hint="Pakistan mobile — 0300…, +92…, or 92…">
          <input className={inputCls} type="tel" value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} placeholder="03001234567" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} />
          Parent opted out of SMS (never message this number)
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save student'}</Button>
        </div>
      </form>
    </Modal>
  );
}
