import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiClientError, API_BASE, getAccessToken } from '../lib/api';
import type { OcrRow, OcrUpload } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import ImageZoom from '../components/ImageZoom';

/** OCR confidence below this is flagged for manual review. */
export const OCR_LOW_CONFIDENCE_THRESHOLD = 0.7;

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/** Human-readable reason for a "Duplicate?" flag, so the badge explains
 * itself instead of leaving the admin guessing what collides. */
function duplicateLabel(reason?: string | null): string {
  if (reason === 'duplicate_name') return 'Duplicate? — same name already in this class';
  if (reason === 'duplicate_roll_no') return 'Duplicate? — roll number already used in this class';
  if (reason === 'duplicate_phone') return 'Duplicate? — same parent number already in this class';
  return 'Duplicate? — matches an existing student in this class';
}

export default function OcrReviewPage() {
  const { id: classId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [upload, setUpload] = useState<OcrUpload | null>(null);
  const [rows, setRows] = useState<OcrRow[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [confirmingSave, setConfirmingSave] = useState(false);
  const [pendingRemoveRow, setPendingRemoveRow] = useState<number | null>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const { push, view } = useToast();

  // Revoke the object URL when the image changes / the page unmounts.
  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  /** Fetch the original photo (authenticated) for the zoomable review view. */
  const loadImage = async (uploadId: string) => {
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_BASE}/ocr-uploads/${uploadId}/image`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const blob = await res.blob();
      setImageUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
    } catch {
      // The review table still works without the image.
    }
  };

  const doUpload = async (file: File) => {
    if (!classId) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('image', file);
      const data = await api<OcrUpload>(`/classes/${classId}/ocr-upload`, { method: 'POST', body: form });
      setUpload(data);
      setRows(data.rows);
      void loadImage(data.upload_id);
      push('success', `OCR found ${data.rows.length} rows — review them below before saving.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setUploading(false);
    }
  };

  const updateRow = (i: number, patch: Partial<OcrRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const addRow = () => setRows((rs) => [...rs, { name: '', roll_no: null, confidence: 1, duplicate: false }]);

  const duplicates = rows.filter((r, i) => {
    const name = r.name.trim().toLowerCase();
    return name !== '' && rows.findIndex((x) => x.name.trim().toLowerCase() === name) !== i;
  }).length;

  const lowConfidenceCount = rows.filter((r) => r.confidence < OCR_LOW_CONFIDENCE_THRESHOLD).length;
  const unverifiedCount = rows.filter((r) => r.verification === 'mismatch').length;
  const missingPhoneCount = rows.filter((r) => !r.parent_phone?.trim()).length;

  const confirmSave = () => {
    if (!classId || !upload) return;
    const cleaned = rows.filter((r) => r.name.trim() !== '');
    if (cleaned.length === 0) {
      push('error', 'No rows to save — add at least one student name.');
      return;
    }
    setConfirmingSave(true);
  };

  const doSave = async () => {
    if (!classId || !upload) return;
    // Rows with no parent number are saved as "-" (the server treats "-"
    // as "no number": never validated, never encrypted, and the student
    // lands in the Parents → Missing number list; SMS skips them).
    const cleaned = rows
      .filter((r) => r.name.trim() !== '')
      .map((r) => ({ ...r, parent_phone: r.parent_phone?.trim() ? r.parent_phone : '-' }));
    setConfirmingSave(false);
    setSaving(true);
    try {
      const res = await api<{ saved: number; skipped_duplicates: number }>(
        `/classes/${classId}/ocr-upload/${upload.upload_id}/confirm`,
        { method: 'POST', body: { rows: cleaned } },
      );
      push('success', `Saved ${res.saved} students (${res.skipped_duplicates} duplicates skipped).`);
      navigate(`/classes/${classId}`);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <button onClick={() => navigate(`/classes/${classId}`)} className="text-sm font-medium text-brand-700 hover:underline">
          ← Back to class
        </button>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Upload student list (OCR)</h1>
        <p className="text-sm text-slate-500">
          Take a photo of the handwritten or printed class list. We read the names (English and Urdu) — you review and fix
          everything before anything is saved.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      {upload && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800" role="alert">
          ⚠️ Review before saving — OCR may contain errors. Nothing is saved until you confirm.
          {lowConfidenceCount > 0
            ? ` ${lowConfidenceCount} row(s) below ${Math.round(OCR_LOW_CONFIDENCE_THRESHOLD * 100)}% confidence are highlighted — check them carefully.`
            : ' All rows are above the confidence threshold.'}
          {unverifiedCount > 0 && ` ${unverifiedCount} name(s) were not confirmed by the second OCR pass — compare them with the photo.`}
          {missingPhoneCount > 0 && ` ${missingPhoneCount} row(s) have no parent number (shown as —); they will appear under Parents → Missing number, and SMS will skip them.`}
        </div>
      )}

      {upload?.warnings && upload.warnings.length > 0 && (
        <div className="space-y-2">
          {upload.warnings.map((w, i) => (
            <div key={i} className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-800" role="alert">
              {w}
            </div>
          ))}
        </div>
      )}

      {!upload && (
        <Card className="p-6 text-center">
          <p className="text-4xl">📷</p>
          <p className="mt-2 font-medium text-slate-800">Choose a photo or scan of the student list</p>
          <p className="mt-1 text-sm text-slate-500">
            Clear, well-lit photos work best. Roll numbers and parent phone numbers are picked up when present.
            Tables with Student / Parent / Number columns are read column by column.
            Names are kept exactly as written on the list — nothing is corrected or re-spelled.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button disabled={uploading} onClick={() => galleryRef.current?.click()}>
              {uploading ? 'Reading image…' : '📁 Upload from Gallery / Files'}
            </Button>
            <Button disabled={uploading} variant="secondary" onClick={() => cameraRef.current?.click()}>
              📷 Take a Photo
            </Button>
            <input
              ref={galleryRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doUpload(f);
                e.target.value = '';
              }}
            />
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doUpload(f);
                e.target.value = '';
              }}
            />
          </div>
          <p className="mt-3 text-xs text-slate-400">
            On phones, “Take a Photo” opens the camera directly; on a computer it opens the file picker — both go through the same check.
          </p>
          {uploading && <Spinner label="Extracting names — this can take a few seconds…" />}
        </Card>
      )}

      {upload && (
        <>
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="blue">{rows.length} rows found</Badge>
              {duplicates > 0 && <Badge tone="amber">{duplicates} possible duplicate(s)</Badge>}
              <Badge tone="slate">Low-confidence rows are marked — please check them</Badge>
              <button className="ml-auto text-sm font-medium text-brand-700 hover:underline" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? 'Hide raw OCR text' : 'Show raw OCR text'}
              </button>
            </div>
            {showRaw && (
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                {upload.raw_text || '(no raw text returned)'}
              </pre>
            )}
          </Card>

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-800">Original photo — zoom in to check a name</h2>
              {imageUrl ? (
                <div className="mt-2">
                  <ImageZoom src={imageUrl} alt="Original photo of the student list" />
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">Loading the photo…</p>
              )}
            </Card>

            <div>
          {rows.length === 0 ? (
            <EmptyState
              title="No names extracted"
              body="Try a clearer photo, or add students manually below."
              actionLabel="Add a missing student"
              onAction={addRow}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[780px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-3">#</th>
                    <th className="px-3 py-3">Name (English)</th>
                    <th className="px-3 py-3">Parent name</th>
                    <th className="px-3 py-3">Name (Urdu)</th>
                    <th className="px-3 py-3">Roll</th>
                    <th className="px-3 py-3">Parent phone</th>
                    <th className="px-3 py-3">Confidence</th>
                    <th className="px-3 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => {
                    const lowConf = r.confidence < OCR_LOW_CONFIDENCE_THRESHOLD;
                    return (
                    <tr key={i} className={lowConf ? 'bg-red-50' : r.duplicate ? 'bg-amber-50' : ''} title={lowConf ? `Low confidence (${Math.round(r.confidence * 100)}%) — please check this row before saving.` : undefined}>
                      <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-2">
                        <input
                          className={`w-full rounded border px-2 py-1 text-sm ${lowConf ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                          value={r.name}
                          onChange={(e) => updateRow(i, { name: e.target.value })}
                          placeholder="Student name" autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={`w-full rounded border px-2 py-1 text-sm ${lowConf ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                          value={r.parent_name ?? ''}
                          onChange={(e) => updateRow(i, { parent_name: e.target.value || null })}
                          placeholder="Parent name"
                          title="Father/guardian name as written on the list (from an “s/o …” tail or the Parents Name column) — saved as the parent name, not part of the student's name."
                          autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={`urdu w-full rounded border px-2 py-1 text-sm ${lowConf ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                          dir="rtl"
                          value={r.name_ur ?? ''}
                          onChange={(e) => updateRow(i, { name_ur: e.target.value })}
                          placeholder="نام" autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={`w-16 rounded border px-2 py-1 text-sm ${lowConf ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                          type="number"
                          min={1}
                          value={r.roll_no ?? ''}
                          onChange={(e) => updateRow(i, { roll_no: e.target.value ? Number(e.target.value) : null })} autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={`w-36 rounded border px-2 py-1 font-mono text-sm ${lowConf ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}
                          value={r.parent_phone ?? ''}
                          onChange={(e) => updateRow(i, { parent_phone: e.target.value })}
                          placeholder="— no number"
                          title="Leave blank when the list has no parent number — it is saved as “—”, shows under Parents → Missing number, and SMS skips the student. Never guess a number."
                          autoComplete="off" />
                      </td>
                      <td className="px-3 py-2">
                        {lowConf ? (
                          <Badge tone="red">{Math.round(r.confidence * 100)}% — check</Badge>
                        ) : (
                          <span className="text-xs text-slate-500">{Math.round(r.confidence * 100)}%</span>
                        )}
                        {r.verification === 'mismatch' && (
                          <span title="The second OCR pass (different settings) did not read this name — compare it with the photo.">
                            <Badge tone="red">2nd pass ✗</Badge>
                          </span>
                        )}
                        {r.verification === 'match' && (
                          <span title="The second OCR pass read this name too.">
                            <Badge tone="green">2nd pass ✓</Badge>
                          </span>
                        )}
                        {r.duplicate && (
                          <span title={duplicateLabel(r.duplicate_reason)}>
                            <Badge tone="amber">Duplicate?</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button className="text-sm font-medium text-red-600 hover:underline" onClick={() => setPendingRemoveRow(i)}>
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

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={addRow}>+ Add a missing student</Button>
            <Button variant="secondary" onClick={() => { setUpload(null); setRows([]); setImageUrl(null); }}>Upload a different photo</Button>
            <Button disabled={saving} onClick={confirmSave} className="ml-auto">
              {saving ? 'Saving…' : `Confirm & save ${rows.filter((r) => r.name.trim()).length} students`}
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmingSave}
        title="Save these students?"
        message={`Are you sure? This will add ${rows.filter((r) => r.name.trim()).length} student(s) to this class from the OCR draft${lowConfidenceCount > 0 ? `, including ${lowConfidenceCount} low-confidence row(s) below ${Math.round(OCR_LOW_CONFIDENCE_THRESHOLD * 100)}% confidence — please check them first` : ''}. Nothing has been saved yet; this is the step that saves them.`}
        confirmLabel={`Save ${rows.filter((r) => r.name.trim()).length} students`}
        tone="primary"
        busy={saving}
        onConfirm={doSave}
        onCancel={() => setConfirmingSave(false)}
      />
      <ConfirmDialog
        open={pendingRemoveRow !== null}
        title="Remove this row?"
        message={pendingRemoveRow !== null && rows[pendingRemoveRow] ? `Are you sure? This will remove the draft row for "${rows[pendingRemoveRow].name || '(no name)'}" — it has not been saved, so this only drops it from the draft.` : ''}
        confirmLabel="Remove row"
        tone="danger"
        onConfirm={() => {
          const i = pendingRemoveRow;
          setPendingRemoveRow(null);
          if (i !== null) removeRow(i);
        }}
        onCancel={() => setPendingRemoveRow(null)}
      />
      {view}
    </div>
  );
}
