// Results page (6B) — result-sheet OCR upload + review, manual entry,
// results list, toppers, pass/fail summary, report cards, export, and
// publish-SMS drafts. All writes go through ConfirmDialog; nothing is
// saved until the admin confirms the review table.
import { useEffect, useRef, useState } from 'react';
import { api, apiDownload, getAccessToken, ApiClientError, API_BASE } from '../lib/api';
import type { ClassItem, ExamItem, PageResult, ResultRow, ResultSheetReviewRow, Student } from '../lib/types';
import { displayClass } from '../lib/utils';
import { Badge, Button, EmptyState, Field, inputCls, Modal, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

const LOW_CONFIDENCE = 0.7;

function rowConfidence(row: ResultSheetReviewRow): number {
  const values = Object.values(row.confidence ?? {});
  if (values.length === 0) return 1;
  return Math.min(...values);
}

interface UploadResponse {
  result_sheet_id: string;
  exam_id: string;
  raw_text: string;
  headings: string[];
  rows: ResultSheetReviewRow[];
  engine: string;
  warnings: string[];
}

interface ReviewData {
  result_sheet_id: string;
  exam: ExamItem;
  class: { id: string; name: string; section: string; display_name: string };
  status: string;
  raw_text: string;
  headings: string[];
  warnings: string[];
  rows: ResultSheetReviewRow[];
}

/**
 * What a result save returns for an admin (direct apply) AND for a clerk
 * (202 approval-queue response: approval_request_id + status, NO saved /
 * exam_id — nothing was applied yet). Round 1 typed only the admin shape,
 * so a clerk save was misread as a completed save: "Saved undefined
 * results", no exam selected, table left empty until the request was
 * approved and the page reloaded. Every save handler must check
 * approval_request_id first (see refreshAfterSave).
 */
interface SaveResultsResponse {
  saved?: number;
  linked?: number;
  unlinked?: number;
  skipped?: Array<{ row: number; reason: string }>;
  exam_id?: string;
  exam_name?: string;
  approval_request_id?: string;
  status?: string;
}

/** Selected exam per class, kept in sessionStorage so a reload right after
 * a save does not drop the selection (the live re-test showed the exam
 * listed but not selected after reload). Best-effort: private mode just
 * means no persistence. */
const examStorageKey = (classId: string): string => `smp:results:exam:${classId}`;
function readStoredExam(classId: string): string {
  try {
    return sessionStorage.getItem(examStorageKey(classId)) ?? '';
  } catch {
    return '';
  }
}
function storeExam(classId: string, examId: string): void {
  try {
    if (examId) sessionStorage.setItem(examStorageKey(classId), examId);
    else sessionStorage.removeItem(examStorageKey(classId));
  } catch {
    /* storage unavailable — selection just won't survive a reload */
  }
}
/** Exam to select for a class: the stored one if it still exists, else the
 * only exam when there is exactly one (the common just-saved case), else
 * "All exams". */
function pickExamForClass(classId: string, list: ExamItem[]): string {
  const stored = readStoredExam(classId);
  if (stored && list.some((e) => e.id === stored)) return stored;
  if (list.length === 1) return list[0]!.id;
  return '';
}

/** Selected class, kept in sessionStorage like the per-class exam above,
 * so a reload right after a save does not drop the class back to the
 * first one (the live re-test showed the class resetting to 4-A with
 * 0 results until re-selected). Best-effort: private mode just means
 * no persistence. */
const CLASS_STORAGE_KEY = 'smp:results:class';
function readStoredClass(): string {
  try {
    return sessionStorage.getItem(CLASS_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}
function storeClass(classId: string): void {
  try {
    if (classId) sessionStorage.setItem(CLASS_STORAGE_KEY, classId);
    else sessionStorage.removeItem(CLASS_STORAGE_KEY);
  } catch {
    /* storage unavailable — selection just won't survive a reload */
  }
}
/** Class to select: the stored one if it still exists, else the first. */
function pickClassForList(list: ClassItem[]): ClassItem | undefined {
  const stored = readStoredClass();
  if (stored) {
    const found = list.find((c) => c.id === stored);
    if (found) return found;
  }
  return list[0];
}

/** D3: per-subject Total for the report card. The backend report-card HTML
 * renders every per-subject Total as a literal "—": the backend stores no
 * per-subject max — a result row carries `subject_marks` ({subject:
 * obtained}) plus ONE overall `total_marks`. The only per-subject max the
 * data supports is the equal split of that total over the row's subjects
 * (the standard school case, e.g. 300 over Maths/English/Science = 100
 * each). Fill each subject row's Total cell in the fetched HTML, in
 * subject order, before it is rendered; a subject whose total cannot be
 * computed (no total_marks) keeps its "—" rather than inventing a number.
 * The "All subjects" fallback row (no subject_marks) already prints
 * obtained/total, so it is untouched. Only the subject table is patched —
 * other "—" text in the card (roll no, father, …) is left alone. */
function formatPerSubjectTotal(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function fillReportCardSubjectTotals(html: string, rows: ResultRow[]): string {
  const perSubjectTotals: Array<string | null> = [];
  for (const r of rows) {
    const subjectCount = Object.keys(r.subject_marks ?? {}).length;
    const total = r.total_marks;
    for (let i = 0; i < subjectCount; i++) {
      perSubjectTotals.push(
        total !== null && total !== undefined && total > 0
          ? formatPerSubjectTotal(total / subjectCount)
          : null,
      );
    }
  }
  if (perSubjectTotals.length === 0 || perSubjectTotals.every((t) => t === null)) return html;
  let idx = 0;
  return html.replace(/<table>[\s\S]*?<\/table>/, (table) =>
    table.replace(/<td>—<\/td>/g, (cell) => {
      const total = perSubjectTotals[idx++];
      return total === null || total === undefined ? cell : `<td>${total}</td>`;
    }),
  );
}

export default function ResultsPage() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [exams, setExams] = useState<ExamItem[]>([]);
  const [classId, setClassId] = useState('');
  const [examId, setExamId] = useState('');
  const [results, setResults] = useState<ResultRow[]>([]);
  const [total, setTotal] = useState(0);
  const [toppers, setToppers] = useState<ResultRow[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  // Upload + review
  const [examName, setExamName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [reviewRows, setReviewRows] = useState<ResultSheetReviewRow[]>([]);
  const [pendingSave, setPendingSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingPublish, setPendingPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Manual entry
  const [showManual, setShowManual] = useState(false);
  const [manualRows, setManualRows] = useState<Array<{ roll_no: string; student_name: string; father_name: string; obtained_marks: string; total_marks: string; remarks: string }>>([
    { roll_no: '', student_name: '', father_name: '', obtained_marks: '', total_marks: '', remarks: '' },
  ]);
  const [manualExamName, setManualExamName] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  // Row edit / link / delete
  const [editing, setEditing] = useState<ResultRow | null>(null);
  const [linking, setLinking] = useState<ResultRow | null>(null);
  const [linkTarget, setLinkTarget] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ResultRow | null>(null);
  const [pendingLink, setPendingLink] = useState<{ row: ResultRow; studentId: string } | null>(null);
  // Report card
  const [reportStudent, setReportStudent] = useState('');
  const [reportHtml, setReportHtml] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const { push, view } = useToast();

  // Exam list: fetched once on mount AND refreshed after every save that
  // can create an exam (manual entry / OCR review). The old code only
  // fetched on mount, so an exam auto-created by a manual save never
  // appeared in the filter until a full page reload — with "All exams"
  // selected, report cards and exports stayed disabled forever.
  // limit=100: the API default page is 20, which would silently truncate
  // the filter for schools with many exams.
  const loadExams = async (): Promise<ExamItem[]> => {
    const e = await api<PageResult<ExamItem>>('/exams?limit=100');
    setExams(e.items);
    return e.items;
  };

  useEffect(() => {
    Promise.all([api<PageResult<ClassItem>>('/classes'), loadExams()])
      .then(([c, e]) => {
        setClasses(c.items);
        if (c.items.length > 0) {
          const first = pickClassForList(c.items)!;
          // Set class + exam together (one batched render) so the results
          // effect runs once, already filtered — and so a reload restores
          // the previously selected class and exam (or the only exam)
          // instead of dropping back to the first class / "All exams".
          // storeClass also clears a stale stored id when the class no
          // longer exists and we fell back to the first class.
          storeClass(first.id);
          setClassId(first.id);
          setExamId(pickExamForClass(first.id, e));
        }
      })
      .catch(() => setError('Could not load classes or exams.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!classId) return;
    api<PageResult<Student>>(`/classes/${classId}/students?limit=200`)
      .then((d) => setStudents(d.items))
      .catch(() => undefined);
  }, [classId]);

  // Takes explicit ids: the save handlers call loadResults(classId,
  // justSavedExamId) right after setExamId, and a closure over the OLD
  // examId state ('') would fetch unfiltered and race the effect's
  // filtered fetch — round 1 did exactly that, so the table/toppers/
  // summary could land for the wrong (unfiltered) view and the exports
  // stayed disabled until a manual reload.
  const loadResults = async (clsId: string = classId, exId: string = examId) => {
    if (!clsId) return;
    setListLoading(true);
    try {
      const q = new URLSearchParams({ class_id: clsId, limit: '200' });
      if (exId) q.set('exam_id', exId);
      const d = await api<PageResult<ResultRow>>(`/results?${q.toString()}`);
      setResults(d.items);
      setTotal(d.total);
      // Safety net: if a result references an exam this page has never
      // seen (created in another tab, or by an OCR upload), refresh the
      // filter list so the exam becomes selectable instead of invisible.
      if (d.items.some((r) => !exams.some((e) => e.id === r.exam_id))) {
        await loadExams().catch(() => undefined);
      }
      if (exId) {
        const [t, s] = await Promise.all([
          api<{ items: ResultRow[] }>(`/results/toppers?exam_id=${exId}&class_id=${clsId}`),
          api<Record<string, unknown>>(`/results/summary?exam_id=${exId}&class_id=${clsId}`),
        ]);
        setToppers(t.items);
        setSummary(s);
      } else {
        setToppers([]);
        setSummary(null);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    void loadResults(classId, examId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, examId]);

  /**
   * Shared post-save refresh for manual entry + OCR-review confirm.
   * Returns false when the save was queued for approval (clerk 202):
   * nothing was applied yet, so there is nothing to select or list — the
   * caller keeps its form open and shows the queued message instead of a
   * fake "Saved N results". On a direct save it refreshes the filter,
   * selects the saved exam (falling back to a name match when the response
   * carries no id), and reloads table + toppers + summary for that exam —
   * all with no page reload, so Export Excel/PDF enable immediately.
   */
  const refreshAfterSave = async (out: SaveResultsResponse, examName: string): Promise<boolean> => {
    if (out.approval_request_id) {
      push('success', 'Submitted for admin approval — nothing was saved yet. The results will appear once an admin approves.');
      return false;
    }
    const fresh = await loadExams().catch(() => exams);
    let target = out.exam_id ?? '';
    if (!target && examName) target = fresh.find((e) => e.name === examName)?.id ?? '';
    if (target) {
      // Guarantee the option exists even if the list refresh raced the
      // save or failed: the response carries the id + name.
      setExams((prev) =>
        prev.some((e) => e.id === target)
          ? prev
          : [...prev, { id: target, name: out.exam_name ?? examName, session_id: null, start_date: null, end_date: null, created_at: new Date().toISOString() }],
      );
      setExamId(target);
      storeExam(classId, target);
      await loadResults(classId, target);
    } else {
      await loadResults(classId, '');
    }
    return true;
  };

  const downloadExport = async (format: 'xlsx' | 'pdf') => {
    try {
      const q = new URLSearchParams({ format, class_id: classId });
      if (examId) q.set('exam_id', examId);
      await apiDownload(`/results/export?${q.toString()}`, format === 'xlsx' ? 'results.xlsx' : 'results.pdf');
    } catch (e) {
      push('error', errText(e));
    }
  };

  const uploadSheet = async (file: File) => {
    if (!examName.trim()) {
      setError('Enter the exam name first (e.g. Midterm, Final, Monthly Test).');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('image', file);
      form.append('exam_name', examName.trim());
      const up = await api<UploadResponse>(`/classes/${classId}/results/upload`, { method: 'POST', body: form });
      const data = await api<ReviewData>(`/result-sheets/${up.result_sheet_id}`);
      setReview(data);
      setReviewRows(data.rows);
      push('success', `Sheet read — ${data.rows.length} rows found. Review before saving.`);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setUploading(false);
    }
  };

  const saveReview = async () => {
    if (!review) return;
    setSaving(true);
    try {
      const rows = reviewRows
        .filter((r) => r.roll_no !== null && r.student_name.trim() !== '')
        .map((r) => ({
          roll_no: r.roll_no as number,
          student_name: r.student_name.trim(),
          father_name: r.father_name || undefined,
          subject_marks: r.subject_marks,
          obtained_marks: r.obtained_marks ?? undefined,
          total_marks: r.total_marks ?? undefined,
          percentage: r.percentage ?? undefined,
          grade: r.grade || undefined,
          remarks: r.remarks || undefined,
          confidence: r.confidence,
        }));
      const out = await api<SaveResultsResponse>(
        `/result-sheets/${review.result_sheet_id}/confirm`,
        { method: 'POST', body: { rows } },
      );
      const applied = await refreshAfterSave(out, review.exam.name);
      if (!applied) return;
      push('success', `Saved ${out.saved} results (${out.linked} linked to students, ${out.unlinked} unlinked).${out.skipped && out.skipped.length > 0 ? ` ${out.skipped.length} rows skipped.` : ''}`);
      setReview(null);
      setReviewRows([]);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setSaving(false);
      setPendingSave(false);
    }
  };

  const publishSms = async () => {
    if (!review) return;
    setPublishing(true);
    try {
      const out = await api<{ drafts_created: number; skipped: Array<{ student_name: string; reason: string }>; approval_request_id?: string }>(
        `/result-sheets/${review.result_sheet_id}/publish`,
        { method: 'POST' },
      );
      if (out.approval_request_id) {
        push('success', 'Submitted for admin approval — no SMS drafts were created yet. Drafts appear once an admin approves.');
        return;
      }
      push('success', `Published. ${out.drafts_created} SMS drafts created for admin approval (${out.skipped.length} skipped).`);
      setReview(null);
      setReviewRows([]);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setPublishing(false);
      setPendingPublish(false);
    }
  };

  const saveManual = async () => {
    const rows = manualRows
      .filter((r) => r.roll_no && r.student_name.trim())
      .map((r) => ({
        roll_no: Number(r.roll_no),
        student_name: r.student_name.trim(),
        father_name: r.father_name.trim() || undefined,
        obtained_marks: r.obtained_marks ? Number(r.obtained_marks) : undefined,
        total_marks: r.total_marks ? Number(r.total_marks) : undefined,
        remarks: r.remarks.trim() || undefined,
      }));
    if (rows.length === 0) {
      push('error', 'Add at least one row with a roll number and a name.');
      return;
    }
    const name = manualExamName.trim() || exams.find((e) => e.id === examId)?.name || '';
    if (!name) {
      push('error', 'Pick an exam or type a new exam name.');
      return;
    }
    setManualSaving(true);
    try {
      const out = await api<SaveResultsResponse>(`/results/manual`, {
        method: 'POST',
        body: { exam_id: examId || undefined, exam_name: examId ? undefined : name, class_id: classId, rows },
      });
      const applied = await refreshAfterSave(out, name);
      if (!applied) return;
      push('success', `Saved ${out.saved} results (${out.linked} linked, ${out.unlinked} unlinked).`);
      setShowManual(false);
      setManualRows([{ roll_no: '', student_name: '', father_name: '', obtained_marks: '', total_marks: '', remarks: '' }]);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setManualSaving(false);
    }
  };

  const viewReportCard = async () => {
    if (!reportStudent || !examId) return;
    setReportLoading(true);
    try {
      const token = getAccessToken();
      const res = await fetch(
        `${API_BASE}/results/report-card/${reportStudent}/${examId}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error('Could not load the report card.');
      // D3: the backend HTML leaves every per-subject Total as "—" — fill
      // it from this student's already-loaded result row(s) for the exam
      // (matched by student id, falling back to name for unlinked rows
      // whose student_id is null). If no row is found the HTML is shown
      // unchanged, so this can only add totals, never break the card.
      const student = students.find((s) => s.id === reportStudent);
      const cardRows = results.filter(
        (r) =>
          r.exam_id === examId &&
          (r.student_id === reportStudent ||
            (r.student_id == null && student !== undefined && r.student_name === student.name)),
      );
      setReportHtml(fillReportCardSubjectTotals(await res.text(), cardRows));
    } catch (e) {
      push('error', errText(e));
    } finally {
      setReportLoading(false);
    }
  };

  if (loading) return <Spinner label="Loading results…" />;
  const cls = classes.find((c) => c.id === classId);
  const lowCount = reviewRows.filter((r) => rowConfidence(r) < LOW_CONFIDENCE).length;
  const flaggedCount = reviewRows.filter((r) => r.flags.length > 0).length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Results</h1>
        <p className="text-sm text-slate-500">Upload a result-sheet photo (OCR), enter marks manually, and publish results to parents.</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {classes.length === 0 ? (
        <EmptyState title="No classes yet" body="Add a class first, then record results for it." actionLabel="Add your first class" actionHref="/classes" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="class-select">Class:</label>
            <select id="class-select" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={classId} onChange={(e) => { const id = e.target.value; storeClass(id); setClassId(id); setExamId(pickExamForClass(id, exams)); }}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {displayClass(c)} — {c.teacher_name}</option>
              ))}
            </select>
            <label className="text-sm font-medium text-slate-700" htmlFor="exam-select">Exam:</label>
            <select id="exam-select" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={examId} onChange={(e) => { setExamId(e.target.value); storeExam(classId, e.target.value); }}>
              <option value="">All exams</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => { setManualExamName(''); setShowManual(true); }}>+ Manual entry</Button>
              {/* Exports unlock as soon as any results exist for the
                  current filter — they no longer require an exam to be
                  picked (the backend exports the whole class when no
                  exam is selected). Previously they were gated on
                  examId, which was unreachable while the filter was
                  stale, so they looked permanently disabled. */}
              <span title={results.length === 0 ? 'No results to export yet' : examId ? 'Export this exam' : 'Export all exams in this class'}>
                <Button
                  variant="secondary"
                  disabled={!classId || results.length === 0}
                  onClick={() => void downloadExport('xlsx')}
                >
                  Export Excel
                </Button>
              </span>
              <span title={results.length === 0 ? 'No results to export yet' : examId ? 'Export this exam' : 'Export all exams in this class'}>
                <Button
                  variant="secondary"
                  disabled={!classId || results.length === 0}
                  onClick={() => void downloadExport('pdf')}
                >
                  Export PDF
                </Button>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <Field label="Exam name for the upload">
              <input className={inputCls} value={examName} onChange={(e) => setExamName(e.target.value)} placeholder="e.g. Midterm" autoComplete="off" />
            </Field>
            <div className="pt-5">
              <Button variant="secondary" disabled={uploading || !classId} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Reading sheet…' : '📷 Upload result sheet (OCR)'}
              </Button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadSheet(f); e.target.value = ''; }} />
            </div>
            <p className="w-full text-xs text-slate-500">Photo or scan of the result sheet (English or Urdu headings). Nothing is saved until you review and confirm.</p>
          </div>

          {summary && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ['Students', String(summary.total ?? '—')],
                ['Passed', String(summary.passed ?? '—')],
                ['Failed', String(summary.failed ?? '—')],
                ['Pass rate', summary.pass_rate !== null && summary.pass_rate !== undefined ? `${summary.pass_rate}%` : '—'],
                ['Average', summary.average_percentage !== null && summary.average_percentage !== undefined ? `${summary.average_percentage}%` : '—'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
                  <p className="text-xl font-bold text-slate-900">{value}</p>
                </div>
              ))}
            </div>
          )}

          {toppers.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <p className="mb-2 font-semibold text-slate-800">🏆 Toppers</p>
              <ol className="space-y-1 text-sm">
                {toppers.slice(0, 5).map((t) => (
                  <li key={t.id}>#{t.position ?? '—'} — {t.student_name} ({t.percentage ?? '—'}%, Grade {t.grade ?? '—'})</li>
                ))}
              </ol>
            </div>
          )}

          {listLoading ? (
            <Spinner label="Loading results…" />
          ) : results.length === 0 ? (
            <EmptyState
              title="No results yet"
              body={cls ? `No results recorded for Class ${displayClass(cls)}${examId ? ' in this exam' : ''} — upload a result sheet or add marks manually.` : 'Pick a class to see results.'}
              actionLabel="Add marks manually"
              onAction={() => setShowManual(true)}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Pos</th>
                    <th className="px-4 py-3">Roll</th>
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">Father</th>
                    <th className="px-4 py-3">Obtained</th>
                    <th className="px-4 py-3">Total</th>
                    <th className="px-4 py-3">%</th>
                    <th className="px-4 py-3">Grade</th>
                    <th className="px-4 py-3">Remarks</th>
                    <th className="px-4 py-3">Linked</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">{r.position ?? '—'}</td>
                      <td className="px-4 py-2.5 font-medium">{r.roll_no}</td>
                      <td className="px-4 py-2.5 font-medium text-slate-900">{r.student_name}</td>
                      <td className="px-4 py-2.5">{r.father_name ?? '—'}</td>
                      <td className="px-4 py-2.5">{r.obtained_marks ?? '—'}</td>
                      <td className="px-4 py-2.5">{r.total_marks ?? '—'}</td>
                      <td className="px-4 py-2.5">{r.percentage ?? '—'}</td>
                      <td className="px-4 py-2.5">{r.grade ?? '—'}</td>
                      <td className="px-4 py-2.5">{r.remarks ?? '—'}</td>
                      <td className="px-4 py-2.5">{r.linked ? <Badge tone="green">Linked</Badge> : <Badge tone="amber">Unlinked</Badge>}</td>
                      <td className="px-4 py-2.5 text-right">
                        <button className="mr-3 font-medium text-brand-700 hover:underline" onClick={() => setEditing(r)}>Edit</button>
                        {!r.linked && (
                          <button className="mr-3 font-medium text-brand-700 hover:underline" onClick={() => { setLinking(r); setLinkTarget(''); }}>Link</button>
                        )}
                        <button className="font-medium text-red-600 hover:underline" onClick={() => setPendingDelete(r)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-2 text-xs text-slate-500">{total} results</p>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="mb-2 font-semibold text-slate-800">Report card</p>
            <div className="flex flex-wrap items-center gap-2">
              <select className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={reportStudent} onChange={(e) => setReportStudent(e.target.value)}>
                <option value="">Select a student…</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.roll_no ? `#${s.roll_no} ` : ''}{s.name}</option>
                ))}
              </select>
              <Button variant="secondary" disabled={!reportStudent || !examId || reportLoading} onClick={() => void viewReportCard()}>
                {reportLoading ? 'Loading…' : 'View report card'}
              </Button>
              <Button
                variant="secondary"
                disabled={!reportStudent || !examId}
                onClick={() => void apiDownload(`/results/report-card/${reportStudent}/${examId}?format=pdf`, 'report-card.pdf')}
              >
                Download PDF
              </Button>
              {!examId && <span className="text-xs text-slate-500">Pick an exam above to enable report cards.</span>}
            </div>
            {reportHtml && (
              <div className="mt-3 max-h-96 overflow-auto rounded-lg border border-slate-200 p-3">
                <div dangerouslySetInnerHTML={{ __html: reportHtml }} />
              </div>
            )}
          </div>
        </>
      )}

      {review && (
        <Modal title={`Review — ${review.exam.name} · Class ${review.class.display_name}`} onClose={() => { setReview(null); setReviewRows([]); }}>
          <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            ⚠️ Review before saving — OCR may contain errors. Nothing is saved until you confirm.
            {lowCount > 0 ? ` ${lowCount} low-confidence rows need a check.` : ' All rows are above the confidence threshold.'}
            {flaggedCount > 0 ? ` ${flaggedCount} rows have mismatch flags.` : ''}
          </div>
          {review.warnings.length > 0 && (
            <p className="mb-3 text-xs text-slate-500">{review.warnings.join(' ')}</p>
          )}
          <div className="max-h-96 overflow-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Roll</th>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Father</th>
                  <th className="px-3 py-2">Obtained</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">%</th>
                  <th className="px-3 py-2">Link</th>
                  <th className="px-3 py-2">Flags</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reviewRows.map((r, i) => {
                  const low = rowConfidence(r) < LOW_CONFIDENCE;
                  return (
                    <tr key={i} className={low ? 'bg-red-50' : ''}>
                      <td className="px-3 py-2">
                        <input className={`${inputCls} w-16 ${low ? 'border-red-400' : ''}`} type="number" value={r.roll_no ?? ''} onChange={(e) => setReviewRows(reviewRows.map((x, j) => (j === i ? { ...x, roll_no: e.target.value ? Number(e.target.value) : null } : x)))} autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        <input className={`${inputCls} ${low ? 'border-red-400' : ''}`} value={r.student_name} onChange={(e) => setReviewRows(reviewRows.map((x, j) => (j === i ? { ...x, student_name: e.target.value } : x)))} autoComplete="off" />
                        {low && <span className="mt-1 block text-xs text-red-600">Low confidence ({Math.round(rowConfidence(r) * 100)}%) — check</span>}
                      </td>
                      <td className="px-3 py-2">
                        <input className={inputCls} value={r.father_name ?? ''} onChange={(e) => setReviewRows(reviewRows.map((x, j) => (j === i ? { ...x, father_name: e.target.value } : x)))} autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        <input className={`${inputCls} w-20 ${r.flags.includes('obtained_gt_total') ? 'border-red-400' : ''}`} type="number" value={r.obtained_marks ?? ''} onChange={(e) => setReviewRows(reviewRows.map((x, j) => (j === i ? { ...x, obtained_marks: e.target.value ? Number(e.target.value) : null } : x)))} autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        <input className={inputCls + ' w-20'} type="number" value={r.total_marks ?? ''} onChange={(e) => setReviewRows(reviewRows.map((x, j) => (j === i ? { ...x, total_marks: e.target.value ? Number(e.target.value) : null } : x)))} autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">{r.percentage ?? '—'}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.link_preview?.mismatch ? (
                          <Badge tone="red">Roll/name mismatch — link manually after save</Badge>
                        ) : r.link_preview?.studentId ? (
                          <Badge tone="green">Links via {r.link_preview.method}</Badge>
                        ) : (
                          <Badge tone="amber">Unlinked — no matching student</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.flags.length > 0 ? r.flags.map((f) => <Badge key={f} tone="red">{f.replaceAll('_', ' ')}</Badge>) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <button className="font-medium text-red-600 hover:underline" onClick={() => setReviewRows(reviewRows.filter((_, j) => j !== i))}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setReviewRows([...reviewRows, { roll_no: null, student_name: '', father_name: null, subject_marks: {}, obtained_marks: null, total_marks: null, percentage: null, grade: null, position: null, remarks: null, extra: {}, confidence: {}, flags: [] }])}>
              + Add row
            </Button>
            <Button variant="secondary" disabled={publishing} onClick={() => setPendingPublish(true)}>Publish & draft SMS to parents</Button>
            <Button disabled={saving || reviewRows.length === 0} onClick={() => setPendingSave(true)}>
              {saving ? 'Saving…' : `Confirm & save ${reviewRows.length} results`}
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">Publish drafts SMS to linked students&apos; parents — drafts wait for admin approval in Messages before anything is sent. No student is ever created from a sheet row.</p>
        </Modal>
      )}

      {showManual && (
        <Modal title="Manual entry" onClose={() => setShowManual(false)}>
          <div className="space-y-3">
            <Field label="Exam">
              {examId ? (
                <p className="text-sm font-medium">{exams.find((e) => e.id === examId)?.name ?? ''}</p>
              ) : (
                <input className={inputCls} value={manualExamName} onChange={(e) => setManualExamName(e.target.value)} placeholder="e.g. Monthly Test (creates the exam if new)" autoComplete="off" />
              )}
            </Field>
            {manualRows.map((r, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-2">
                <div className="grid grid-cols-4 gap-2">
                  <input className={inputCls} type="number" placeholder="Roll" value={r.roll_no} onChange={(e) => setManualRows(manualRows.map((x, j) => (j === i ? { ...x, roll_no: e.target.value } : x)))} autoComplete="off" />
                  <input className={inputCls} placeholder="Student name" value={r.student_name} onChange={(e) => setManualRows(manualRows.map((x, j) => (j === i ? { ...x, student_name: e.target.value } : x)))} autoComplete="off" />
                  <input className={inputCls} type="number" placeholder="Obtained" value={r.obtained_marks} onChange={(e) => setManualRows(manualRows.map((x, j) => (j === i ? { ...x, obtained_marks: e.target.value } : x)))} autoComplete="off" />
                  <input className={inputCls} type="number" placeholder="Total" value={r.total_marks} onChange={(e) => setManualRows(manualRows.map((x, j) => (j === i ? { ...x, total_marks: e.target.value } : x)))} autoComplete="off" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input className={inputCls} placeholder="Father's name (optional)" value={r.father_name} onChange={(e) => setManualRows(manualRows.map((x, j) => (j === i ? { ...x, father_name: e.target.value } : x)))} autoComplete="off" />
                  <input className={inputCls} placeholder="Remarks (optional, e.g. Good effort)" value={r.remarks} onChange={(e) => setManualRows(manualRows.map((x, j) => (j === i ? { ...x, remarks: e.target.value } : x)))} autoComplete="off" />
                </div>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setManualRows([...manualRows, { roll_no: '', student_name: '', father_name: '', obtained_marks: '', total_marks: '', remarks: '' }])}>+ Add row</Button>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowManual(false)}>Cancel</Button>
              <Button disabled={manualSaving} onClick={() => void saveManual()}>{manualSaving ? 'Saving…' : 'Save results'}</Button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit — ${editing.student_name}`} onClose={() => setEditing(null)}>
          <EditResultForm
            row={editing}
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null);
              setResults(results.map((x) => (x.id === saved.id ? saved : x)));
              push('success', 'Result updated.');
            }}
          />
        </Modal>
      )}

      {linking && (
        <Modal title={`Link — ${linking.student_name} (roll ${linking.roll_no})`} onClose={() => setLinking(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">No student was matched automatically. Pick the existing student this row belongs to — this never creates a student.</p>
            <Field label="Student in this class">
              <select className={inputCls} value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}>
                <option value="">Select a student…</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.roll_no ? `#${s.roll_no} ` : ''}{s.name}</option>
                ))}
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setLinking(null)}>Cancel</Button>
              <Button disabled={!linkTarget} onClick={() => { const r = linking; setLinking(null); setPendingLink({ row: r, studentId: linkTarget }); }}>Continue</Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={pendingSave}
        title="Save these results?"
        message={review ? `Are you sure? This will save ${reviewRows.length} results for ${review.exam.name} (Class ${review.class.display_name}). ${lowCount} low-confidence rows and ${flaggedCount} flagged rows will be saved as shown — check them first.` : ''}
        confirmLabel="Save results"
        tone="primary"
        busy={saving}
        onConfirm={() => void saveReview()}
        onCancel={() => setPendingSave(false)}
      />
      <ConfirmDialog
        open={pendingPublish}
        title="Publish results & draft SMS?"
        message={review ? `Are you sure? This will mark the ${review.exam.name} sheet published and create SMS drafts to the parents of linked students. Drafts wait for admin approval — nothing is sent yet.` : ''}
        confirmLabel="Publish & draft SMS"
        tone="primary"
        busy={publishing}
        onConfirm={() => void publishSms()}
        onCancel={() => setPendingPublish(false)}
      />
      <ConfirmDialog
        open={pendingLink !== null}
        title="Link this result?"
        message={pendingLink ? `Are you sure? This will link ${pendingLink.row.student_name}'s result (roll ${pendingLink.row.roll_no}) to the selected student. The student record itself is not changed.` : ''}
        confirmLabel="Link result"
        tone="primary"
        onConfirm={async () => {
          const p = pendingLink;
          setPendingLink(null);
          if (!p) return;
          try {
            const saved = await api<ResultRow>(`/results/${p.row.id}/link`, { method: 'POST', body: { student_id: p.studentId } });
            setResults(results.map((x) => (x.id === saved.id ? saved : x)));
            push('success', 'Result linked.');
          } catch (e) {
            push('error', errText(e));
          }
        }}
        onCancel={() => setPendingLink(null)}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this result?"
        message={pendingDelete ? `Are you sure? This will delete ${pendingDelete.student_name}'s result (roll ${pendingDelete.roll_no}). It goes to the recycle bin and can be restored for 30 days.` : ''}
        confirmLabel="Delete result"
        tone="danger"
        onConfirm={async () => {
          const r = pendingDelete;
          setPendingDelete(null);
          if (!r) return;
          try {
            await api(`/results/${r.id}`, { method: 'DELETE' });
            setResults(results.filter((x) => x.id !== r.id));
            push('success', 'Result deleted (recycle bin).');
          } catch (e) {
            push('error', errText(e));
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
      {view}
    </div>
  );
}

function EditResultForm({ row, onClose, onSaved }: { row: ResultRow; onClose: () => void; onSaved: (r: ResultRow) => void }) {
  const [obtained, setObtained] = useState(row.obtained_marks !== null && row.obtained_marks !== undefined ? String(row.obtained_marks) : '');
  const [total, setTotal] = useState(row.total_marks !== null && row.total_marks !== undefined ? String(row.total_marks) : '');
  const [fatherName, setFatherName] = useState(row.father_name ?? '');
  const [remarks, setRemarks] = useState(row.remarks ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <form
      autoComplete="off"
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const saved = await api<ResultRow>(`/results/${row.id}`, {
            method: 'PATCH',
            body: {
              obtained_marks: obtained ? Number(obtained) : null,
              total_marks: total ? Number(total) : null,
              father_name: fatherName.trim() || null,
              remarks: remarks || null,
            },
          });
          onSaved(saved);
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Obtained marks">
          <input className={inputCls} type="number" value={obtained} onChange={(e) => setObtained(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Total marks">
          <input className={inputCls} type="number" value={total} onChange={(e) => setTotal(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <Field label="Remarks">
        <input className={inputCls} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Good effort" autoComplete="off" />
      </Field>
      <Field label="Father's name">
        <input className={inputCls} value={fatherName} onChange={(e) => setFatherName(e.target.value)} placeholder="e.g. Muhammad Raza" autoComplete="off" />
      </Field>
      <p className="text-xs text-slate-500">Percentage and grade are recomputed from the marks; positions are recomputed for the whole exam and class.</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </form>
  );
}
