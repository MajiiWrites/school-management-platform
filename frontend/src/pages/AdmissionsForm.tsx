// Public admissions form (Gap #2, 2026-11-20) — /admissions/:schoolSlug.
// No login: a parent fills in the child's details and the school picks
// the inquiry up in its pipeline. Includes a hidden honeypot field that
// real parents never see (bots fill it and get silently dropped).
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { admissionsApi, ApiClientError } from '../lib/api';
import type { AdmissionsFormData } from '../lib/types';
import { Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner } from '../components/ui';
import DeveloperFooter from '../components/DeveloperFooter';

export default function AdmissionsFormPage() {
  const { slug } = useParams<{ slug: string }>();
  const [form, setForm] = useState<AdmissionsFormData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [studentName, setStudentName] = useState('');
  const [classId, setClassId] = useState('');
  const [parentName, setParentName] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [notes, setNotes] = useState('');
  // Honeypot — rendered off-screen; a filled value means a bot.
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const load = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError('');
    try {
      setForm(await admissionsApi.getForm(slug));
    } catch (e) {
      setError(
        e instanceof ApiClientError && e.status === 404
          ? 'This admissions page does not exist. Please check the link from the school.'
          : 'Could not open this page. Check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!slug) return;
    setSubmitError('');
    setSubmitting(true);
    try {
      await admissionsApi.submit(slug, {
        student_name: studentName.trim(),
        class_id: classId,
        parent_name: parentName.trim(),
        parent_phone: parentPhone.trim(),
        parent_email: parentEmail.trim() || undefined,
        notes: notes.trim() || undefined,
        website: website || undefined,
      });
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof ApiClientError ? err.message : 'Could not send your inquiry. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Spinner label="Opening admissions…" />;

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl bg-slate-50 px-4 py-6">
      <div className="mb-4 text-center">
        <p className="text-xl font-bold text-brand-900">🏫 Student Manager</p>
        <p className="text-sm text-slate-500">Admission inquiry — no login needed</p>
      </div>

      {!form ? (
        <EmptyState title="Page could not be opened" body={error || 'Ask the school for a fresh admissions link.'} />
      ) : submitted ? (
        <Card className="p-6 text-center">
          <p className="text-4xl">✅</p>
          <h1 className="mt-2 text-xl font-bold text-slate-900">Inquiry received</h1>
          <p className="mt-1 text-sm text-slate-500">
            Thank you — {form.school_name} has your admission inquiry for {studentName.trim()}. The school will contact
            you at {parentPhone.trim()}.
          </p>
        </Card>
      ) : (
        <Card className="p-5">
          <h1 className="text-lg font-bold text-slate-900">Apply for admission — {form.school_name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Fill this in and the school will contact you about the next step (test / interview).
          </p>
          {submitError && <ErrorBanner message={submitError} />}
          <form onSubmit={submit} className="mt-4 space-y-4" autoComplete="off">
            <Field label="Student name">
              <input className={inputCls} value={studentName} onChange={(e) => setStudentName(e.target.value)} required maxLength={120} />
            </Field>
            <Field label="Class applying for">
              <select className={inputCls} value={classId} onChange={(e) => setClassId(e.target.value)} required>
                <option value="">Choose a class…</option>
                {form.classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    Class {c.display_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Parent / guardian name">
              <input className={inputCls} value={parentName} onChange={(e) => setParentName(e.target.value)} required maxLength={120} />
            </Field>
            <Field label="Parent phone" hint="Pakistan mobile — 0300…, +92…, or 92…">
              <input className={inputCls} type="tel" value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} placeholder="03001234567" required />
            </Field>
            <Field label="Parent email (optional)">
              <input className={inputCls} type="email" value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} />
            </Field>
            <Field label="Anything the school should know? (optional)">
              <textarea className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} rows={3} />
            </Field>
            {/* Honeypot: hidden from humans, bots fill it. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-0 overflow-hidden">
              <label>
                Website
                <input type="text" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" />
              </label>
            </div>
            <Button type="submit" disabled={submitting} className="w-full py-3 text-base">
              {submitting ? 'Sending…' : 'Send admission inquiry'}
            </Button>
          </form>
        </Card>
      )}
      <DeveloperFooter />
    </div>
  );
}
