// Timetable page (6C-1): class-wise and teacher-wise weekly views,
// add/edit/delete entries. Conflicts are rejected by the server with a
// friendly message and shown inline.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult, StaffItem, TimetableEntryItem, TimetablePhotoCell, TimetablePhotoConfirmResult, TimetablePhotoUpload } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import ImageZoom from '../components/ImageZoom';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Human-readable flag labels for photo-import review rows. */
function photoFlagLabel(flag: string): string {
  switch (flag) {
    case 'missing_teacher': return 'No teacher';
    case 'missing_time': return 'No time';
    case 'missing_subject': return 'No subject';
    case 'period_inferred': return 'Period from row order';
    case 'teacher_double_booked': return 'Teacher double-booked';
    case 'class_double_booked': return 'Class double-booked';
    case 'unmatched_teacher': return 'Teacher not found';
    case 'unmatched_class': return 'Class not found';
    case 'low_confidence': return 'Unclear reading';
    default: return flag;
  }
}

/** Flags that block saving until the admin fixes the row. */
const PHOTO_BLOCKING_FLAGS = new Set(['missing_time', 'missing_subject', 'teacher_double_booked', 'class_double_booked']);

export default function TimetablePage() {
  const [view, setView] = useState<'class' | 'teacher'>('class');
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [teachers, setTeachers] = useState<StaffItem[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedTeacher, setSelectedTeacher] = useState('');
  const [entries, setEntries] = useState<TimetableEntryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ class_id: '', teacher_id: '', day_of_week: '1', period_no: '1', subject: '', start_time: '08:00', end_time: '08:45', room: '' });
  const [pendingDelete, setPendingDelete] = useState<TimetableEntryItem | null>(null);
  const { push, view: toastView } = useToast();

  // --- Timetable from photo (Point 7) --------------------------------------
  const [photo, setPhoto] = useState<TimetablePhotoUpload | null>(null);
  const [photoCells, setPhotoCells] = useState<TimetablePhotoCell[]>([]);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoClassId, setPhotoClassId] = useState('');
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoSaving, setPhotoSaving] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const photoGalleryRef = useRef<HTMLInputElement>(null);
  const photoCameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  }, [photoPreviewUrl]);

  const updatePhotoCell = (i: number, patch: Partial<TimetablePhotoCell>) => {
    setPhotoCells((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  };

  const removePhotoCell = (i: number) => setPhotoCells((cs) => cs.filter((_, j) => j !== i));

  const doPhotoUpload = async (file: File) => {
    setPhotoUploading(true);
    setPhotoError('');
    try {
      const formData = new FormData();
      formData.append('image', file);
      if (photoClassId) formData.append('class_id', photoClassId);
      const data = await api<TimetablePhotoUpload>('/timetable/photo-upload', { method: 'POST', body: formData });
      setPhoto(data);
      setPhotoCells(data.cells);
      setPhotoPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(file);
      });
      push('success', `Read ${data.cells.length} period(s) from the photo — review them below before saving.`);
    } catch (e) {
      setPhotoError(errText(e));
    } finally {
      setPhotoUploading(false);
    }
  };

  const photoBlockingCount = photoCells.filter((c) => {
    if (!c.class_id || c.day_of_week === null || c.period_no === null || !c.subject?.trim() || !c.start_time || !c.end_time) return true;
    return c.flags.some((f) => PHOTO_BLOCKING_FLAGS.has(f));
  }).length;

  const confirmPhoto = async () => {
    if (photoBlockingCount > 0) {
      push('error', `${photoBlockingCount} row(s) still need fixing (missing class, time, subject, or a double-booking) — nothing was saved.`);
      return;
    }
    setPhotoSaving(true);
    try {
      // Resolve class-teacher pseudo-ids ("name:...") into real staff rows first.
      const entries = [];
      for (const c of photoCells) {
        const teacherId = c.teacher_id ? await resolveTeacherId(c.teacher_id) : null;
        entries.push({
          class_id: c.class_id!,
          teacher_id: teacherId,
          day_of_week: c.day_of_week!,
          period_no: c.period_no!,
          subject: c.subject!.trim(),
          start_time: c.start_time!,
          end_time: c.end_time!,
          room: null,
        });
      }
      const res = await api<TimetablePhotoConfirmResult>('/timetable/photo-confirm', { method: 'POST', body: { entries } });
      if ((res as { status?: string })?.status === 'pending') {
        push('success', 'Submitted for admin approval — nothing was applied yet.');
      } else {
        const skipped = res.skipped.length > 0 ? ` (${res.skipped.length} row(s) skipped: ${res.skipped.map((s) => s.reason).join('; ')})` : '';
        push('success', `Saved ${res.created} lesson(s) from the photo${skipped}. They now appear in both the Class-wise and Teacher-wise views.`);
      }
      const firstClassId = entries[0]?.class_id ?? '';
      setPhoto(null);
      setPhotoCells([]);
      setPhotoPreviewUrl(null);
      if (firstClassId) {
        setView('class');
        setSelectedClass(firstClassId);
      }
    } catch (e) {
      push('error', errText(e));
    } finally {
      setPhotoSaving(false);
    }
  };

  // Phase 9 fix: the teacher dropdown only listed staff rows with
  // role=teacher, but class teachers live as plain `teacher_name` strings
  // on classes — schools that never added staff rows saw only
  // "No teacher", so teacher-wise timetables were unusable. Offer the
  // class teachers too: picking one creates the staff row on first use
  // (value `name:<teacher name>`), after which it behaves like any
  // staff teacher.
  const teacherOptions = useMemo(() => {
    const staffNames = new Set(teachers.map((t) => t.name.trim().toLowerCase()));
    const opts: { value: string; label: string }[] = teachers.map((t) => ({ value: t.id, label: t.name }));
    for (const c of classes) {
      const name = (c.teacher_name ?? '').trim();
      if (!name || staffNames.has(name.toLowerCase())) continue;
      staffNames.add(name.toLowerCase());
      opts.push({ value: `name:${name}`, label: `${name} — Class ${c.name}-${c.section} teacher` });
    }
    return opts;
  }, [teachers, classes]);

  const selectedTeacherIsNameOnly = selectedTeacher.startsWith('name:');

  const resolveTeacherId = async (value: string): Promise<string | null> => {
    if (!value) return null;
    if (!value.startsWith('name:')) return value;
    const name = value.slice('name:'.length);
    const created = await api<{ id?: string; status?: string }>('/staff', {
      method: 'POST',
      body: { name, role: 'teacher' },
    });
    if (!created.id) {
      // Clerk create went to the approval queue (202) — no staff row yet.
      throw new Error('That teacher was submitted for admin approval — add the lesson once they approve it.');
    }
    // Refresh the staff list so the new teacher stays selectable.
    api<PageResult<StaffItem>>('/staff?role=teacher&limit=200')
      .then((d) => setTeachers(d.items))
      .catch(() => undefined);
    return created.id;
  };

  const loadMeta = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<ClassItem>>('/classes?limit=200'),
      api<PageResult<StaffItem>>('/staff?role=teacher&limit=200'),
    ])
      .then(([cc, tt]) => {
        setClasses(cc.items);
        setTeachers(tt.items);
        setError('');
      })
      .catch(() => setError('Could not load timetable.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(loadMeta, [loadMeta]);

  useEffect(() => {
    if (view === 'class' && !selectedClass) {
      setEntries([]);
      return;
    }
    if (view === 'teacher' && !selectedTeacher) {
      setEntries([]);
      return;
    }
    // A class teacher with no staff row yet has no lessons to show.
    if (view === 'teacher' && selectedTeacherIsNameOnly) {
      setEntries([]);
      return;
    }
    const q = view === 'class' ? `class_id=${selectedClass}` : `teacher_id=${selectedTeacher}`;
    api<PageResult<TimetableEntryItem>>(`/timetable?${q}&limit=200`)
      .then((d) => setEntries(d.items))
      .catch(() => undefined);
  }, [view, selectedClass, selectedTeacher, selectedTeacherIsNameOnly]);

  const reloadEntries = () => {
    const q = view === 'class' ? `class_id=${selectedClass}` : `teacher_id=${selectedTeacher}`;
    if (!selectedClass && view === 'class') return;
    if (!selectedTeacher && view === 'teacher') return;
    api<PageResult<TimetableEntryItem>>(`/timetable?${q}&limit=200`)
      .then((d) => setEntries(d.items))
      .catch(() => undefined);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const teacherId = await resolveTeacherId(form.teacher_id);
      const r = await api('/timetable', {
        method: 'POST',
        body: {
          class_id: form.class_id,
          teacher_id: teacherId,
          day_of_week: Number(form.day_of_week),
          period_no: Number(form.period_no),
          subject: form.subject.trim(),
          start_time: form.start_time,
          end_time: form.end_time,
          room: form.room.trim() || null,
        },
      });
      if ((r as { status?: string })?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
      else push('success', 'Timetable entry added.');
      // If a class teacher was just turned into a staff row, switch the
      // teacher-wise view to them so the new lesson shows up.
      if (view === 'teacher' && selectedTeacherIsNameOnly && teacherId) setSelectedTeacher(teacherId);
      setForm({ ...form, subject: '', room: '' });
      reloadEntries();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      await api(`/timetable/${id}`, { method: 'DELETE' });
      push('success', 'Timetable entry deleted.');
      reloadEntries();
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading timetable…" />;

  const byDay: Record<number, TimetableEntryItem[]> = {};
  for (let d = 0; d <= 6; d += 1) byDay[d] = [];
  for (const e of entries) byDay[e.day_of_week].push(e);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Timetable</h1>
        <p className="text-sm text-slate-500">Weekly lessons by class or by teacher. A class and a teacher can never be double-booked.</p>
      </div>
      {error && <ErrorBanner message={error} onRetry={loadMeta} />}
      <Tabs
        tabs={[
          { key: 'class', label: 'Class-wise' },
          { key: 'teacher', label: 'Teacher-wise' },
        ]}
        active={view}
        onChange={(k) => setView(k as 'class' | 'teacher')}
      />

      <div className="flex gap-2">
        {view === 'class' ? (
          <select className={inputCls + ' w-auto'} value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
            <option value="">Select a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
            ))}
          </select>
        ) : (
          <select className={inputCls + ' w-auto'} value={selectedTeacher} onChange={(e) => setSelectedTeacher(e.target.value)}>
            <option value="">Select a teacher…</option>
            {teacherOptions.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        )}
      </div>

      {view === 'teacher' && selectedTeacherIsNameOnly && (
        <p className="text-sm text-slate-500">
          {selectedTeacher.slice('name:'.length)} is a class teacher with no staff record yet — no lessons are
          scheduled for them. Add a lesson below with this teacher and they will be added to staff automatically.
        </p>
      )}

      {(view === 'class' ? !selectedClass : !selectedTeacher) ? (
        <EmptyState title={view === 'class' ? 'Pick a class' : 'Pick a teacher'} body="Choose one above to see the weekly timetable." />
      ) : entries.length === 0 ? (
        <EmptyState title="No lessons scheduled" body="Add the first lesson with the form below." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {DAYS.map((day, d) => (
            <Card key={day} className="p-4">
              <h3 className="text-sm font-semibold">{day}</h3>
              {byDay[d].length === 0 ? (
                <p className="mt-2 text-sm text-slate-400">No lessons</p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-100 text-sm">
                  {byDay[d].map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-2 py-2">
                      <Badge tone="blue">P{e.period_no}</Badge>
                      <span className="font-medium">{e.subject}</span>
                      <span className="text-slate-500">
                        {e.start_time}–{e.end_time}
                        {e.room ? ` · Room ${e.room}` : ''}
                        {view === 'class' ? (e.teacher_name ? ` · ${e.teacher_name}` : '') : ` · ${e.class_name ?? ''}`}
                      </span>
                      <Button variant="ghost" onClick={() => setPendingDelete(e)}>Remove</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* --- Timetable from photo (Point 7) --- */}
      <Card className="p-5">
        <h2 className="text-base font-semibold">Upload timetable photo</h2>
        <p className="mt-1 text-sm text-slate-500">
          Take a photo of the timetable sheet — we read the days, periods, times, subjects and teachers. You review
          everything next to the photo before anything is saved. Nothing is guessed: unreadable cells are flagged,
          teachers/classes that do not match are listed for you to pick, and no new teacher or class is ever created
          from a photo.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="This sheet is for class (optional)">
            <select className={inputCls} value={photoClassId} onChange={(e) => setPhotoClassId(e.target.value)}>
              <option value="">Whole-school sheet / not sure</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
              ))}
            </select>
          </Field>
          <Button disabled={photoUploading} onClick={() => photoGalleryRef.current?.click()}>
            {photoUploading ? 'Reading photo…' : '📁 Upload from Gallery / Files'}
          </Button>
          <Button disabled={photoUploading} variant="secondary" onClick={() => photoCameraRef.current?.click()}>
            📷 Take a Photo
          </Button>
          <input
            ref={photoGalleryRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doPhotoUpload(f);
              e.target.value = '';
            }}
          />
          <input
            ref={photoCameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doPhotoUpload(f);
              e.target.value = '';
            }}
          />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          On phones, “Take a Photo” opens the camera directly; on a computer it opens the file picker — both go through the same check.
        </p>
        {photoUploading && <Spinner label="Reading the timetable — this can take a few seconds…" />}
        {photoError && <ErrorBanner message={photoError} />}
      </Card>

      {photo && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">Review the photo timetable</h2>
          <p className="mt-1 text-sm text-slate-500">
            Check every row against the photo. Rows with a red or amber flag need your attention — a row with a missing
            time/subject or a double-booking cannot be saved until you fix it. Unmatched teachers/classes: pick the
            right one from the list (nothing is created from the photo).
          </p>
          {photo.warnings.length > 0 && (
            <div className="mt-2 space-y-2">
              {photo.warnings.map((w, i) => (
                <div key={i} className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-2 text-sm text-sky-800">{w}</div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone="blue">{photoCells.length} period(s) read</Badge>
            {photo.unmatched_teachers.length > 0 && (
              <Badge tone="amber">Unmatched teachers: {photo.unmatched_teachers.join(', ')}</Badge>
            )}
            {photo.unmatched_classes.length > 0 && (
              <Badge tone="amber">Unmatched classes: {photo.unmatched_classes.join(', ')}</Badge>
            )}
            {photoBlockingCount > 0 && <Badge tone="red">{photoBlockingCount} row(s) need fixing</Badge>}
          </div>

          <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Original photo — zoom in to check a time or name</h3>
              {photoPreviewUrl ? (
                <div className="mt-2">
                  <ImageZoom src={photoPreviewUrl} alt="Original photo of the timetable sheet" />
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">Photo preview unavailable.</p>
              )}
            </div>

            <div>
              {photoCells.length === 0 ? (
                <EmptyState title="No periods read" body="Try a clearer, straight-on photo, or add the timetable manually below." />
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-3">Day</th>
                        <th className="px-3 py-3">Period</th>
                        <th className="px-3 py-3">Start</th>
                        <th className="px-3 py-3">End</th>
                        <th className="px-3 py-3">Class</th>
                        <th className="px-3 py-3">Teacher</th>
                        <th className="px-3 py-3">Subject</th>
                        <th className="px-3 py-3">Flags</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {photoCells.map((c, i) => {
                        const blocked = !c.class_id || c.day_of_week === null || c.period_no === null || !c.subject?.trim() || !c.start_time || !c.end_time || c.flags.some((f) => PHOTO_BLOCKING_FLAGS.has(f));
                        return (
                          <tr key={i} className={blocked ? 'bg-red-50' : c.flags.length > 0 ? 'bg-amber-50' : ''}>
                            <td className="px-3 py-2">
                              <select
                                className={inputCls}
                                value={c.day_of_week ?? ''}
                                onChange={(e) => updatePhotoCell(i, { day_of_week: e.target.value === '' ? null : Number(e.target.value), day_label: e.target.value === '' ? null : DAYS[Number(e.target.value)] ?? null })}
                              >
                                <option value="">Pick day…</option>
                                {DAYS.map((d, di) => (
                                  <option key={d} value={di}>{d}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                min={1}
                                className={`w-16 rounded border px-2 py-1 text-sm ${blocked ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                                value={c.period_no ?? ''}
                                onChange={(e) => updatePhotoCell(i, { period_no: e.target.value ? Number(e.target.value) : null })}
                                autoComplete="off"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="time"
                                className={`w-28 rounded border px-2 py-1 text-sm ${blocked ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                                value={c.start_time ?? ''}
                                onChange={(e) => updatePhotoCell(i, { start_time: e.target.value || null })}
                                autoComplete="off"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="time"
                                className={`w-28 rounded border px-2 py-1 text-sm ${blocked ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                                value={c.end_time ?? ''}
                                onChange={(e) => updatePhotoCell(i, { end_time: e.target.value || null })}
                                autoComplete="off"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <select
                                className={inputCls}
                                value={c.class_id ?? ''}
                                onChange={(e) => {
                                  const klass = classes.find((k) => k.id === e.target.value);
                                  updatePhotoCell(i, { class_id: e.target.value || null, class_label: klass ? `${klass.name}-${klass.section}` : c.class_label });
                                }}
                              >
                                <option value="">Pick class…</option>
                                {classes.map((k) => (
                                  <option key={k.id} value={k.id}>Class {k.name}-{k.section}</option>
                                ))}
                              </select>
                              {c.class_label && !c.class_id && (
                                <div className="mt-0.5 text-xs text-amber-700">On sheet: “{c.class_label}” — no match</div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <select
                                className={inputCls}
                                value={c.teacher_id ?? ''}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  const opt = teacherOptions.find((t) => t.value === v);
                                  updatePhotoCell(i, {
                                    teacher_id: v || null,
                                    teacher_name: opt ? opt.label.replace(/ — Class .*$/, '') : null,
                                  });
                                }}
                              >
                                <option value="">No teacher</option>
                                {teacherOptions.map((t) => (
                                  <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                              </select>
                              {c.teacher_name && !c.teacher_id && (
                                <div className="mt-0.5 text-xs text-amber-700">On sheet: “{c.teacher_name}” — no match</div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <input
                                className={`w-28 rounded border px-2 py-1 text-sm ${blocked ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                                value={c.subject ?? ''}
                                onChange={(e) => updatePhotoCell(i, { subject: e.target.value || null })}
                                placeholder="Subject"
                                autoComplete="off"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {c.flags.map((f) => (
                                  <Badge key={f} tone={PHOTO_BLOCKING_FLAGS.has(f) || f === 'unmatched_teacher' || f === 'unmatched_class' ? 'red' : 'amber'}>
                                    {photoFlagLabel(f)}
                                  </Badge>
                                ))}
                                {c.flags.length === 0 && <span className="text-xs text-slate-400">OK</span>}
                              </div>
                              <div className="mt-0.5 text-xs text-slate-400" title={c.source_text}>“{c.source_text}”</div>
                            </td>
                            <td className="px-3 py-2">
                              <button className="text-sm font-medium text-red-600 hover:underline" onClick={() => removePhotoCell(i)}>
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => { setPhoto(null); setPhotoCells([]); setPhotoPreviewUrl(null); }}>
              Discard photo
            </Button>
            <Button disabled={photoSaving || photoCells.length === 0} onClick={confirmPhoto} className="ml-auto">
              {photoSaving ? 'Saving…' : `Confirm & save ${photoCells.length} lesson(s)`}
            </Button>
          </div>
          {photoBlockingCount > 0 && (
            <p className="mt-2 text-sm text-red-700">
              {photoBlockingCount} row(s) cannot be saved yet — fill in the missing class, day, period, time or subject, or resolve the double-booking.
            </p>
          )}
        </Card>
      )}

      <Card className="p-5">
        <h2 className="text-base font-semibold">Add a lesson</h2>
        <form onSubmit={create} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label="Class">
            <select
              className={inputCls}
              value={form.class_id}
              onChange={(e) => {
                const classId = e.target.value;
                const next = { ...form, class_id: classId };
                // Default the teacher to this class's teacher when none is picked.
                if (!form.teacher_id && classId) {
                  const klass = classes.find((c) => c.id === classId);
                  const name = (klass?.teacher_name ?? '').trim();
                  if (name) {
                    const staff = teachers.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
                    next.teacher_id = staff ? staff.id : `name:${name}`;
                  }
                }
                setForm(next);
              }}
              required
            >
              <option value="">Select…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
              ))}
            </select>
          </Field>
          <Field label="Teacher (optional)">
            <select className={inputCls} value={form.teacher_id} onChange={(e) => setForm({ ...form, teacher_id: e.target.value })}>
              <option value="">No teacher</option>
              {teacherOptions.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Day">
            <select className={inputCls} value={form.day_of_week} onChange={(e) => setForm({ ...form, day_of_week: e.target.value })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Period">
            <input type="number" min={1} className={inputCls} value={form.period_no} onChange={(e) => setForm({ ...form, period_no: e.target.value })} autoComplete="off" required />
          </Field>
          <Field label="Subject">
            <input className={inputCls} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Math" autoComplete="off" required />
          </Field>
          <Field label="Start time">
            <input type="time" className={inputCls} value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} autoComplete="off" required />
          </Field>
          <Field label="End time">
            <input type="time" className={inputCls} value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} autoComplete="off" required />
          </Field>
          <Field label="Room (optional)">
            <input className={inputCls} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} placeholder="Room 4" autoComplete="off" />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Add lesson</Button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove this lesson?"
        message={pendingDelete ? `Are you sure? This will remove "${pendingDelete.subject}" (period ${pendingDelete.period_no}, ${pendingDelete.day_name}) from the timetable.` : ''}
        confirmLabel="Remove lesson"
        tone="danger"
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {toastView}
    </div>
  );
}
