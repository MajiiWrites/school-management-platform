// Staff & payroll page (6C-1; payroll SIMPLIFIED — Module E FINAL REBUILD):
// staff profiles + class assignments, and one simple payroll section —
// record a payment (month + staff + amount); each staff member's month
// shows Paid / Partially Paid / Unpaid with the remaining amount, and a
// downloadable Salary Slip (PDF) per staff member and month.
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, apiDownload, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult, PayrollSummaryItem, SalarySlipData, StaffAssignmentItem, StaffItem } from '../lib/types';
import { currentMonth, fmtPKR, monthName } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

const STATUS_LABEL: Record<string, string> = { paid: 'Paid', partial: 'Partially Paid', unpaid: 'Unpaid' };
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red'> = { paid: 'green', partial: 'amber', unpaid: 'red' };

export default function StaffPage() {
  const [tab, setTab] = useState('staff');
  const [staff, setStaff] = useState<StaffItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [payroll, setPayroll] = useState<PayrollSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [form, setForm] = useState({ name: '', role: 'teacher' as 'teacher' | 'staff', phone: '', email: '', joining_date: '', subjects: '', salary_monthly: '' });
  const [selected, setSelected] = useState<StaffItem | null>(null);
  const [assignments, setAssignments] = useState<StaffAssignmentItem[]>([]);
  const [assignClass, setAssignClass] = useState('');
  const [assignSubject, setAssignSubject] = useState('');
  const [payForm, setPayForm] = useState({ staff_id: '', amount: '' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [slip, setSlip] = useState<SalarySlipData | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'staff' | 'payment' | 'assignment'; id: string; label: string; staffId?: string } | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<StaffItem>>(`/staff?limit=200${roleFilter ? `&role=${roleFilter}` : ''}`),
      api<PageResult<ClassItem>>('/classes?limit=200'),
      api<PageResult<PayrollSummaryItem>>(`/payroll?month=${month}&limit=200`),
    ])
      .then(([ss, cc, pp]) => {
        setStaff(ss.items);
        setClasses(cc.items);
        setPayroll(pp.items);
        setError('');
      })
      .catch(() => setError('Could not load staff.'))
      .finally(() => setLoading(false));
  }, [roleFilter, month]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!selected) {
      setAssignments([]);
      return;
    }
    api<{ items: StaffAssignmentItem[] }>(`/staff/${selected.id}/assignments`)
      .then((d) => setAssignments(d.items))
      .catch(() => undefined);
  }, [selected]);

  const createStaff = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/staff', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          role: form.role,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          joining_date: form.joining_date || null,
          subjects: form.subjects.split(',').map((s) => s.trim()).filter(Boolean),
          salary_monthly: form.salary_monthly ? Number(form.salary_monthly) : null,
        },
      });
      if ((r as { status?: string })?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
      else push('success', 'Staff member added.');
      setForm({ name: '', role: 'teacher', phone: '', email: '', joining_date: '', subjects: '', salary_monthly: '' });
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const addAssignment = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await api(`/staff/${selected.id}/assign`, { method: 'POST', body: { class_id: assignClass, subject: assignSubject.trim() } });
      push('success', 'Assignment added.');
      setAssignClass('');
      setAssignSubject('');
      api<{ items: StaffAssignmentItem[] }>(`/staff/${selected.id}/assignments`).then((d) => setAssignments(d.items)).catch(() => undefined);
    } catch (err) {
      push('error', errText(err));
    }
  };

  const recordPayment = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/payroll', {
        method: 'POST',
        body: { staff_id: payForm.staff_id, month, amount: Number(payForm.amount) },
      });
      if ((r as { status?: string })?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
      else push('success', 'Payment recorded.');
      setPayForm({ staff_id: '', amount: '' });
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const openSlip = async (staffId: string) => {
    try {
      const data = await api<SalarySlipData>(`/payroll/slip?staff_id=${staffId}&month=${month}&format=json`);
      setSlip(data);
    } catch (err) {
      push('error', errText(err));
    }
  };

  const downloadSlipPdf = async () => {
    if (!slip) return;
    try {
      await apiDownload(`/payroll/slip?staff_id=${slip.staff_id}&month=${month}&format=pdf`, `salary-slip-${slip.staff_name.replace(/[^A-Za-z0-9]+/g, '-')}-${month}.pdf`);
    } catch (err) {
      push('error', errText(err));
    }
  };

  const doDelete = async () => {
    const d = pendingDelete;
    setPendingDelete(null);
    if (!d) return;
    try {
      if (d.kind === 'staff') await api(`/staff/${d.id}`, { method: 'DELETE' });
      else if (d.kind === 'payment') await api(`/payroll/${d.id}`, { method: 'DELETE' });
      else if (d.staffId) await api(`/staff/${d.staffId}/assign/${d.id}`, { method: 'DELETE' });
      push('success', 'Deleted.');
      if (d.kind === 'assignment' && selected) {
        api<{ items: StaffAssignmentItem[] }>(`/staff/${selected.id}/assignments`).then((x) => setAssignments(x.items)).catch(() => undefined);
      } else {
        load();
      }
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading staff…" />;

  const paidTotal = payroll.reduce((a, p) => a + p.amount_paid, 0);
  const remainingTotal = payroll.reduce((a, p) => a + (p.remaining ?? 0), 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Staff & payroll</h1>
        <p className="text-sm text-slate-500">Teachers and staff, class assignments, and monthly salaries.</p>
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}
      <Tabs
        tabs={[
          { key: 'staff', label: 'Staff' },
          { key: 'payroll', label: `Payroll — ${monthName(month)}` },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'staff' && (
        <>
          <Card className="p-5">
            <h2 className="text-base font-semibold">Add staff member</h2>
            <form onSubmit={createStaff} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Name">
                <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" autoComplete="off" required />
              </Field>
              <Field label="Role">
                <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'teacher' | 'staff' })}>
                  <option value="teacher">Teacher</option>
                  <option value="staff">Staff</option>
                </select>
              </Field>
              <Field label="Phone (PK mobile)">
                <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="03001234567" autoComplete="off" />
              </Field>
              <Field label="Email (optional)">
                <input type="email" className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" autoComplete="off" />
              </Field>
              <Field label="Joining date">
                <input type="date" className={inputCls} value={form.joining_date} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} autoComplete="off" />
              </Field>
              <Field label="Subjects (comma separated)">
                <input className={inputCls} value={form.subjects} onChange={(e) => setForm({ ...form, subjects: e.target.value })} placeholder="Math, Science" autoComplete="off" />
              </Field>
              <Field label="Monthly salary (PKR)">
                <input type="number" min={0} className={inputCls} value={form.salary_monthly} onChange={(e) => setForm({ ...form, salary_monthly: e.target.value })} placeholder="60000" autoComplete="off" />
              </Field>
              <div className="flex items-end">
                <Button type="submit">Add staff</Button>
              </div>
            </form>
          </Card>

          <div className="flex gap-2">
            <select className={inputCls + ' w-auto'} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="">All roles</option>
              <option value="teacher">Teachers</option>
              <option value="staff">Staff</option>
            </select>
          </div>

          {staff.length === 0 ? (
            <EmptyState title="No staff yet" body="Add your first teacher or staff member above." />
          ) : (
            <div className="space-y-3">
              {staff.map((s) => (
                <Card key={s.id} className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge tone={s.role === 'teacher' ? 'blue' : 'slate'}>{s.role}</Badge>
                    <span className="text-sm text-slate-500">
                      {s.phone_masked ?? 'No phone'}
                      {s.subjects.length > 0 ? ` · ${s.subjects.join(', ')}` : ''}
                      {s.salary_monthly !== null ? ` · ${fmtPKR(s.salary_monthly)}/mo` : ''}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button variant="ghost" onClick={() => setSelected(selected?.id === s.id ? null : s)}>
                        {selected?.id === s.id ? 'Hide assignments' : 'Assignments'}
                      </Button>
                      <Button variant="ghost" onClick={() => setPendingDelete({ kind: 'staff', id: s.id, label: s.name })}>Delete</Button>
                    </span>
                  </div>
                  {selected?.id === s.id && (
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      {assignments.length === 0 ? (
                        <p className="text-sm text-slate-500">No class assignments yet.</p>
                      ) : (
                        <ul className="divide-y divide-slate-100 text-sm">
                          {assignments.map((a) => (
                            <li key={a.id} className="flex items-center gap-2 py-2">
                              <span className="font-medium">{a.subject}</span>
                              <span className="text-slate-500">Class {a.class_name}</span>
                              <Button variant="ghost" onClick={() => setPendingDelete({ kind: 'assignment', id: a.id, label: a.subject, staffId: s.id })}>Remove</Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <form onSubmit={addAssignment} autoComplete="off" className="mt-3 flex flex-wrap gap-3">
                        <select className={inputCls + ' w-auto'} value={assignClass} onChange={(e) => setAssignClass(e.target.value)} required>
                          <option value="">Select class…</option>
                          {classes.map((c) => (
                            <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
                          ))}
                        </select>
                        <input className={inputCls + ' w-auto'} value={assignSubject} onChange={(e) => setAssignSubject(e.target.value)} placeholder="Subject" autoComplete="off" required />
                        <Button type="submit">Assign</Button>
                      </form>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'payroll' && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input type="month" className={inputCls + ' w-auto'} value={month} onChange={(e) => setMonth(e.target.value || currentMonth())} autoComplete="off" />
            <p className="text-sm text-slate-500">
              Paid: <strong className="text-brand-700">{fmtPKR(paidTotal)}</strong> · Remaining: <strong className="text-red-600">{fmtPKR(remainingTotal)}</strong>
            </p>
          </div>

          <Card className="p-5">
            <h2 className="text-base font-semibold">Record a payment — {monthName(month)}</h2>
            <p className="mt-1 text-sm text-slate-500">One payment is just a staff member, the month, and the amount. Record it in parts if you like — partial payments add up, and the status updates automatically.</p>
            <form onSubmit={recordPayment} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Staff member">
                <select className={inputCls} value={payForm.staff_id} onChange={(e) => setPayForm({ ...payForm, staff_id: e.target.value })} required>
                  <option value="">Select…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.salary_monthly !== null ? ` (${fmtPKR(s.salary_monthly)}/mo)` : ''}</option>
                  ))}
                </select>
              </Field>
              <Field label="Amount paid (PKR)">
                <input type="number" min={1} className={inputCls} value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} placeholder="20000" autoComplete="off" required />
              </Field>
              <div className="flex items-end">
                <Button type="submit">Record payment</Button>
              </div>
            </form>
          </Card>

          {payroll.length === 0 ? (
            <EmptyState title="No staff yet" body="Add staff members first — each one then shows here as Unpaid until you record a payment." />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Staff</th>
                    <th className="px-4 py-3 text-right">Monthly salary</th>
                    <th className="px-4 py-3 text-right">Paid</th>
                    <th className="px-4 py-3 text-right">Remaining</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {payroll.map((p) => (
                    <Fragment key={p.staff_id}>
                      <tr className="border-b border-slate-100">
                        <td className="px-4 py-3 font-medium">{p.staff_name}</td>
                        <td className="px-4 py-3 text-right">{p.monthly_salary !== null ? fmtPKR(p.monthly_salary) : '—'}</td>
                        <td className="px-4 py-3 text-right">{fmtPKR(p.amount_paid)}</td>
                        <td className="px-4 py-3 text-right font-semibold">{p.remaining !== null ? fmtPKR(p.remaining) : '—'}</td>
                        <td className="px-4 py-3"><Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge></td>
                        <td className="px-4 py-3 text-right">
                          <Button variant="ghost" onClick={() => openSlip(p.staff_id)}>Salary slip</Button>
                          <Button variant="ghost" onClick={() => setExpanded(expanded === p.staff_id ? null : p.staff_id)}>
                            {expanded === p.staff_id ? 'Hide payments' : `Payments (${p.payments.length})`}
                          </Button>
                        </td>
                      </tr>
                      {expanded === p.staff_id && (
                        <tr key={`${p.staff_id}-payments`} className="border-b border-slate-100 bg-slate-50">
                          <td colSpan={6} className="px-4 py-3">
                            {p.payments.length === 0 ? (
                              <p className="text-sm text-slate-500">No payments recorded for {monthName(month)} yet.</p>
                            ) : (
                              <ul className="divide-y divide-slate-100 text-sm">
                                {p.payments.map((pay) => (
                                  <li key={pay.id} className="flex items-center gap-2 py-2">
                                    <span className="font-medium">{fmtPKR(pay.amount)}</span>
                                    <span className="text-slate-500">{pay.paid_at ? new Date(pay.paid_at).toLocaleDateString('en-GB') : ''}</span>
                                    <Button variant="ghost" onClick={() => setPendingDelete({ kind: 'payment', id: pay.id, label: `${p.staff_name} — ${fmtPKR(pay.amount)} (${monthName(month)})` })}>Delete</Button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {slip && (
        <Modal title={`Salary slip — ${slip.staff_name} (${monthName(slip.month)})`} onClose={() => setSlip(null)}>
          <div className="space-y-2 text-sm">
            <p><span className="text-slate-500">School:</span> <strong>{slip.school_name}</strong></p>
            <p><span className="text-slate-500">Month:</span> {monthName(slip.month)}</p>
            <p><span className="text-slate-500">Status:</span> {STATUS_LABEL[slip.status]}</p>
            <table className="w-full border-collapse text-sm">
              <tbody>
                <tr className="border-b border-slate-100"><td className="py-2">Monthly salary</td><td className="py-2 text-right">{slip.monthly_salary !== null ? fmtPKR(slip.monthly_salary) : '—'}</td></tr>
                {slip.payments.map((pay, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-2">Payment {i + 1}{pay.paid_at ? ` — ${new Date(pay.paid_at).toLocaleDateString('en-GB')}` : ''}</td>
                    <td className="py-2 text-right">{fmtPKR(pay.amount)}</td>
                  </tr>
                ))}
                <tr className="border-b border-slate-100 font-bold"><td className="py-2">Amount paid</td><td className="py-2 text-right">{fmtPKR(slip.amount_paid)}</td></tr>
                <tr className="font-bold"><td className="py-2">Amount remaining</td><td className="py-2 text-right">{slip.remaining !== null ? fmtPKR(slip.remaining) : '—'}</td></tr>
              </tbody>
            </table>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setSlip(null)}>Close</Button>
              <Button onClick={downloadSlipPdf}>Download PDF</Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `Delete ${pendingDelete.kind}?` : ''}
        message={pendingDelete ? `Are you sure? This will delete "${pendingDelete.label}".${pendingDelete.kind === 'staff' ? ' Staff with payment records or timetable entries cannot be deleted.' : pendingDelete.kind === 'payment' ? ' The month total and status will update automatically.' : ''}` : ''}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {view}
    </div>
  );
}
