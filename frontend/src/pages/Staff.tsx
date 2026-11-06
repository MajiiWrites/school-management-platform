// Staff & payroll page (6C-1): staff profiles + class assignments, and the
// monthly payroll with mark paid/unpaid and a printable payslip.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult, SalaryRecordItem, StaffAssignmentItem, StaffItem } from '../lib/types';
import { currentMonth, fmtPKR, monthName } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export default function StaffPage() {
  const [tab, setTab] = useState('staff');
  const [staff, setStaff] = useState<StaffItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [payroll, setPayroll] = useState<SalaryRecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [form, setForm] = useState({ name: '', role: 'teacher' as 'teacher' | 'staff', phone: '', email: '', joining_date: '', subjects: '', salary_monthly: '' });
  const [selected, setSelected] = useState<StaffItem | null>(null);
  const [assignments, setAssignments] = useState<StaffAssignmentItem[]>([]);
  const [assignClass, setAssignClass] = useState('');
  const [assignSubject, setAssignSubject] = useState('');
  const [payForm, setPayForm] = useState({ staff_id: '', base_salary: '', deductions: '' });
  const [payslip, setPayslip] = useState<SalaryRecordItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'staff' | 'payroll' | 'assignment'; id: string; label: string; staffId?: string } | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<StaffItem>>(`/staff?limit=200${roleFilter ? `&role=${roleFilter}` : ''}`),
      api<PageResult<ClassItem>>('/classes?limit=200'),
      api<PageResult<SalaryRecordItem>>(`/payroll?month=${month}&limit=200`),
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

  const createPayroll = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/payroll', {
        method: 'POST',
        body: { staff_id: payForm.staff_id, month, base_salary: payForm.base_salary ? Number(payForm.base_salary) : null, deductions: payForm.deductions ? Number(payForm.deductions) : 0 },
      });
      if ((r as { status?: string })?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
      else push('success', 'Salary record created.');
      setPayForm({ staff_id: '', base_salary: '', deductions: '' });
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const togglePaid = async (row: SalaryRecordItem) => {
    try {
      await api(`/payroll/${row.id}`, { method: 'PATCH', body: { paid: !row.paid } });
      push('success', row.paid ? 'Marked unpaid.' : 'Marked paid.');
      load();
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
      else if (d.kind === 'payroll') await api(`/payroll/${d.id}`, { method: 'DELETE' });
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

  const paidTotal = payroll.filter((p) => p.paid).reduce((a, p) => a + p.net_pay, 0);
  const unpaidTotal = payroll.filter((p) => !p.paid).reduce((a, p) => a + p.net_pay, 0);

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
              Paid: <strong className="text-brand-700">{fmtPKR(paidTotal)}</strong> · Unpaid: <strong className="text-red-600">{fmtPKR(unpaidTotal)}</strong>
            </p>
          </div>

          <Card className="p-5">
            <h2 className="text-base font-semibold">New salary record — {monthName(month)}</h2>
            <form onSubmit={createPayroll} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-4">
              <Field label="Staff member">
                <select className={inputCls} value={payForm.staff_id} onChange={(e) => setPayForm({ ...payForm, staff_id: e.target.value })} required>
                  <option value="">Select…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.salary_monthly !== null ? ` (${fmtPKR(s.salary_monthly)})` : ''}</option>
                  ))}
                </select>
              </Field>
              <Field label="Base salary (blank = profile salary)">
                <input type="number" min={0} className={inputCls} value={payForm.base_salary} onChange={(e) => setPayForm({ ...payForm, base_salary: e.target.value })} placeholder="60000" autoComplete="off" />
              </Field>
              <Field label="Deductions (PKR)">
                <input type="number" min={0} className={inputCls} value={payForm.deductions} onChange={(e) => setPayForm({ ...payForm, deductions: e.target.value })} placeholder="0" autoComplete="off" />
              </Field>
              <div className="flex items-end">
                <Button type="submit">Add salary</Button>
              </div>
            </form>
          </Card>

          {payroll.length === 0 ? (
            <EmptyState title="No salary records for this month" body="Add a salary record above — the base salary defaults to the staff member's profile salary." />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Staff</th>
                    <th className="px-4 py-3">Payslip</th>
                    <th className="px-4 py-3 text-right">Base</th>
                    <th className="px-4 py-3 text-right">Deductions</th>
                    <th className="px-4 py-3 text-right">Net pay</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {payroll.map((p) => (
                    <tr key={p.id} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-medium">{p.staff_name}</td>
                      <td className="px-4 py-3 text-slate-500">{p.payslip_no}</td>
                      <td className="px-4 py-3 text-right">{fmtPKR(p.base_salary)}</td>
                      <td className="px-4 py-3 text-right">{fmtPKR(p.deductions)}</td>
                      <td className="px-4 py-3 text-right font-semibold">{fmtPKR(p.net_pay)}</td>
                      <td className="px-4 py-3">{p.paid ? <Badge tone="green">Paid</Badge> : <Badge tone="red">Unpaid</Badge>}</td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" onClick={() => setPayslip(p)}>Payslip</Button>
                        <Button variant="ghost" onClick={() => togglePaid(p)}>{p.paid ? 'Mark unpaid' : 'Mark paid'}</Button>
                        {!p.paid && <Button variant="ghost" onClick={() => setPendingDelete({ kind: 'payroll', id: p.id, label: `${p.staff_name} — ${p.month}` })}>Delete</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <Modal title={payslip ? `Payslip — ${payslip.staff_name} (${monthName(payslip.month)})` : ''} onClose={() => setPayslip(null)}>
        {payslip && (
          <div className="space-y-2 text-sm">
            <p><span className="text-slate-500">Payslip No:</span> <strong>{payslip.payslip_no}</strong></p>
            <p><span className="text-slate-500">Month:</span> {monthName(payslip.month)}</p>
            <p><span className="text-slate-500">Status:</span> {payslip.paid ? 'Paid' : 'Unpaid'}</p>
            <table className="w-full border-collapse text-sm">
              <tbody>
                <tr className="border-b border-slate-100"><td className="py-2">Base salary</td><td className="py-2 text-right">{fmtPKR(payslip.base_salary)}</td></tr>
                <tr className="border-b border-slate-100"><td className="py-2">Deductions</td><td className="py-2 text-right">− {fmtPKR(payslip.deductions)}</td></tr>
                <tr className="font-bold"><td className="py-2">Net pay</td><td className="py-2 text-right">{fmtPKR(payslip.net_pay)}</td></tr>
              </tbody>
            </table>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setPayslip(null)}>Close</Button>
              <Button onClick={() => window.print()}>Print / Save as PDF</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `Delete ${pendingDelete.kind}?` : ''}
        message={pendingDelete ? `Are you sure? This will delete "${pendingDelete.label}".${pendingDelete.kind === 'staff' ? ' Staff with salary records or timetable entries cannot be deleted.' : ''}` : ''}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {view}
    </div>
  );
}
