import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, apiPrint, ApiClientError } from '../lib/api';
import type { ClassItem, FeeRow, FeeStructure, PageResult } from '../lib/types';
import { currentMonth, fmtPKR, monthName, todayISO } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, Tabs, useToast } from '../components/ui';
import Tooltip from '../components/Tooltip'; // P8-TOUR: plain-word tooltips on confusing labels.
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/** D3: rows with no_structure === true are NOT paid — their class has no
 * fee structure and no record, so the backend's GENERATED 'paid' status
 * (balance 0 <= 0) is a phantom. Show a neutral badge instead. */
function statusBadge(s: FeeRow['status'], noStructure?: boolean) {
  if (noStructure) return <Badge tone="slate">No fee structure</Badge>;
  if (s === 'paid') return <Badge tone="green">Paid</Badge>;
  if (s === 'partial') return <Badge tone="amber">Partial</Badge>;
  return <Badge tone="red">Unpaid</Badge>;
}

export default function FeesPage() {
  const [month, setMonth] = useState(currentMonth());
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'partial' | 'unpaid'>('all');
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [structures, setStructures] = useState<FeeStructure[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [tab, setTab] = useState('fees');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState<FeeRow | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [editingStructure, setEditingStructure] = useState<FeeStructure | 'new' | null>(null);
  const [deletingStructure, setDeletingStructure] = useState<FeeStructure | null>(null);
  // 6C-2: fee vouchers / challans for the month.
  const [vouchers, setVouchers] = useState<{ voucher_no: string; student_name: string; class_name: string; month: string; amount_due: number; due_date: string; status: string }[]>([]);
  const [voucherBusy, setVoucherBusy] = useState(false);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<FeeRow>>(`/fees?month=${month}&limit=200`),
      // GET /fees/structures returns a BARE ARRAY, not a PageResult —
      // reading `.items` off it yields undefined and blanked the page.
      api<FeeStructure[]>('/fees/structures'),
      api<PageResult<{ voucher_no: string; student_name: string; class_name: string; month: string; amount_due: number; due_date: string; status: string }>>(`/fees/vouchers?month=${month}&limit=200`),
      api<PageResult<ClassItem>>('/classes'),
    ])
      .then(([f, s, v, c]) => {
        setFees(Array.isArray(f?.items) ? f.items : []);
        setStructures(Array.isArray(s) ? s : []);
        setVouchers(Array.isArray(v?.items) ? v.items : []);
        setClasses(Array.isArray(c?.items) ? c.items : []);
        setError('');
      })
      .catch(() => setError('Could not load fees.'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(load, [load]);

  // D3: no_structure rows carry the backend's GENERATED 'paid' status but
  // are not paid — exclude them from the Paid filter (they stay visible
  // under "All statuses" with the "No fee structure" badge).
  const filtered = fees.filter((f) =>
    statusFilter === 'all' ? true : statusFilter === 'paid' ? f.status === 'paid' && !f.no_structure : f.status === statusFilter,
  );
  // D3: no_structure rows contribute 0 to both totals (amount_due,
  // amount_paid and discount are all 0), so Collected/Pending stay honest.
  const collected = fees.reduce((a, f) => a + (f.amount_paid ?? 0), 0);
  const pending = fees.reduce((a, f) => a + ((f.amount_due ?? 0) - (f.amount_paid ?? 0) - (f.discount ?? 0)), 0);

  if (loading) return <Spinner label="Loading fees…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fees — {monthName(month)}</h1>
          <p className="text-sm text-slate-500">Mark payments, print receipts, and track the month.</p>
        </div>
        <input
          type="month"
          className={inputCls + ' w-auto'}
          value={month}
          onChange={(e) => setMonth(e.target.value || currentMonth())} autoComplete="off" />
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Collected</p>
          <p className="mt-1 text-2xl font-bold text-brand-700">{fmtPKR(collected)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Pending</p>
          <p className="mt-1 text-2xl font-bold text-amber-600">{fmtPKR(Math.max(0, pending))}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Paid students</p>
          {/* D3: no_structure rows are excluded from the Paid count (their
              GENERATED 'paid' status is a phantom). Denominator stays the
              total row count so paid + unpaid + partial + no-structure = all
              students shown. */}
          <p className="mt-1 text-2xl font-bold text-slate-900">{fees.filter((f) => f.status === 'paid' && !f.no_structure).length} / {fees.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Unpaid students</p>
          {/* D3: no_structure rows are excluded here too (defensive — the
              backend synthesises them as 'paid', never 'unpaid'). */}
          <p className="mt-1 text-2xl font-bold text-red-600">{fees.filter((f) => f.status === 'unpaid' && !f.no_structure).length}</p>
        </Card>
      </div>

      <Tabs
        tabs={[
          { key: 'fees', label: 'Monthly fees' },
          { key: 'structures', label: 'Fee structures' },
          { key: 'report', label: 'Monthly report' },
          { key: 'vouchers', label: 'Vouchers' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'fees' && (
        <>
          <div className="flex gap-2">
            <select className={inputCls + ' w-auto'} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="all">All statuses</option>
              <option value="paid">Paid</option>
              <option value="partial">Partial</option>
              <option value="unpaid">Unpaid</option>
            </select>
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title="No fee records for this month"
              body="Fee records are created automatically at the start of each month from the fee structures."
              actionLabel="View fee structures"
              onAction={() => setTab('structures')}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">Class</th>
                    <th className="px-4 py-3">Due</th>
                    <th className="px-4 py-3">Paid</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Receipt</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((f) => (
                    <tr key={`${f.student_id}-${f.month}`} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-900">{f.student_name}</td>
                      <td className="px-4 py-2.5">{f.class_name}</td>
                      <td className="px-4 py-2.5">{fmtPKR(f.amount_due ?? 0)}</td>
                      <td className="px-4 py-2.5">{fmtPKR(f.amount_paid ?? 0)}</td>
                      <td className="px-4 py-2.5">{statusBadge(f.status, f.no_structure)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{f.receipt_no ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          className="mr-3 font-medium text-brand-700 hover:underline disabled:opacity-40"
                          disabled={voucherBusy || !f.record_id}
                          title={f.record_id ? 'Generate / print the fee voucher (challan)' : 'No fee record yet — record a payment or run the rollover first'}
                          onClick={async () => {
                            setVoucherBusy(true);
                            try {
                              const v = await api<{ voucher_no: string }>(`/fees/vouchers/by-student`, { method: 'POST', body: { student_id: f.student_id, month } });
                              push('success', `Voucher ${v.voucher_no} ready.`);
                              load();
                              await apiPrint(`/fees/vouchers/${v.voucher_no}`);
                            } catch (e) {
                              push('error', errText(e));
                            } finally {
                              setVoucherBusy(false);
                            }
                          }}
                        >
                          Voucher
                        </button>
                        {/* Collect and Receipt are ALWAYS rendered, so neither
                            flickers between loads. Collect is enabled whenever
                            there is something to collect: a fee record exists
                            for this student/month, or a structure gives this
                            row an amount due (pay creates the record on the
                            fly). It is disabled only when the month is fully
                            paid, or when there is no structure and no record
                            (nothing due at all). Receipt is enabled only once
                            a payment exists (receipt_no set); otherwise it is
                            disabled with the reason as its hint. */}
                        <Button
                          variant="secondary"
                          disabled={f.status === 'paid' || (!f.record_exists && (f.amount_due ?? 0) <= 0)}
                          title={
                            f.status === 'paid'
                              ? 'Already paid in full for this month'
                              : !f.record_exists && (f.amount_due ?? 0) <= 0
                                ? 'No fee structure for this class yet — set one in Fee structures first'
                                : 'Record a payment for this student'
                          }
                          onClick={() => setPaying(f)}
                        >
                          Collect
                        </Button>{' '}
                        <button
                          className="font-medium text-brand-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:no-underline"
                          disabled={!f.receipt_no}
                          title={f.receipt_no ? 'View the payment receipt' : 'No receipt yet — record a payment first'}
                          onClick={async () => {
                            if (!f.receipt_no) return;
                            try {
                              // ?format=json: the receipt endpoint serves an
                              // HTML page by default, which the JSON client
                              // cannot parse (Receipt used to do nothing).
                              const r = await api<ReceiptData>(`/fees/receipts/${f.receipt_no}?format=json`);
                              setReceipt(r);
                            } catch (e) {
                              push('error', errText(e));
                            }
                          }}
                        >
                          Receipt
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'structures' && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Monthly fee per class</h2>
              <p className="mt-1 text-sm text-slate-500">
                New fee records are created from these structures at the start of each month. Paid records are never re-created.
              </p>
            </div>
            <Button onClick={() => setEditingStructure('new')}>Add fee structure</Button>
          </div>
          {structures.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                title="No fee structures yet"
                body="Add a class first, then set its monthly fee here."
                actionLabel="Add your first class"
                actionHref="/classes"
              />
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {structures.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="font-medium">Class {s.class_name ?? '—'}</span>
                  <span className="text-slate-600">
                    {fmtPKR(s.monthly_amount ?? 0)} / month · from {s.effective_from ?? '—'}
                    {(s.admission_fee ?? 0) > 0 ? ` · admission ${fmtPKR(s.admission_fee ?? 0)}` : ''}
                    {(s.sibling_discount_pct ?? 0) > 0 ? ` · sibling discount ${s.sibling_discount_pct}%` : ''}
                  </span>
                  <span className="flex gap-3">
                    <button className="font-medium text-brand-700 hover:underline" onClick={() => setEditingStructure(s)}>Edit</button>
                    <button className="font-medium text-red-600 hover:underline" onClick={() => setDeletingStructure(s)}>Delete</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'report' && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">Monthly report — {monthName(month)}</h2>
          <p className="mt-2 text-sm text-slate-700">Collected: <strong>{fmtPKR(collected)}</strong></p>
          <p className="text-sm text-slate-700">Pending: <strong>{fmtPKR(Math.max(0, pending))}</strong></p>
          <p className="mt-3 text-sm text-slate-500">
            Paid students are excluded from the 1st-of-month fee reminders automatically. A full per-class breakdown is available
            from Reports.
          </p>
          {/* P8-TOUR: arrears, explained in plain words. */}
          <p className="mt-2 text-sm text-slate-500">
            Arrears
            <Tooltip text="Fee left unpaid from earlier months. It is added to the next month's amount due, so a student who paid only part of last month still owes the rest." />
            {' '}from earlier months are included in the pending amount above.
          </p>
        </Card>
      )}

      {tab === 'vouchers' && (
        <>
          {/* P8-TOUR: voucher, explained in plain words. */}
          <p className="text-sm text-slate-500">
            A voucher
            <Tooltip text="A voucher (challan) is a printed bill for one student for one month. It shows how much is due and the last date to pay. Generate one from a student's row in the Monthly fees tab, then print it and hand it to the parent." />
            {' '}is a printed bill (challan) for one student — generate it from a student&apos;s row in the Monthly fees tab.
          </p>
          {vouchers.length === 0 ? (
            <EmptyState
              title="No vouchers for this month"
              body="Generate a voucher (challan) from a student's row in the Monthly fees tab — it shows the amount payable and the due date."
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Voucher no.</th>
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">Class</th>
                    <th className="px-4 py-3">Payable</th>
                    <th className="px-4 py-3">Due date</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Print</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vouchers.map((v) => (
                    <tr key={v.voucher_no} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-mono text-xs">{v.voucher_no}</td>
                      <td className="px-4 py-2.5 font-medium">{v.student_name}</td>
                      <td className="px-4 py-2.5">{v.class_name}</td>
                      <td className="px-4 py-2.5">{fmtPKR(v.amount_due)}</td>
                      <td className="px-4 py-2.5">{v.due_date}</td>
                      <td className="px-4 py-2.5">{statusBadge(v.status as FeeRow['status'])}</td>
                      <td className="px-4 py-2.5 text-right">
                        <button className="font-medium text-brand-700 hover:underline" onClick={() => apiPrint(`/fees/vouchers/${v.voucher_no}`).catch((e) => push('error', errText(e)))}>Print</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {paying && (
        <PayModal
          fee={paying}
          month={month}
          onClose={() => setPaying(null)}
          onDone={async (receiptNo) => {
            setPaying(null);
            push('success', `Payment recorded — receipt ${receiptNo}.`);
            load();
            try {
              const r = await api<ReceiptData>(`/fees/receipts/${receiptNo}?format=json`);
              setReceipt(r);
            } catch {
              /* receipt view is optional */
            }
          }}
        />
      )}

      {receipt && (
        <Modal title={`Receipt ${receipt.receipt_no}`} onClose={() => setReceipt(null)}>
          <div className="print-area rounded-lg border border-slate-200 p-5 text-sm">
            <p className="text-center text-lg font-bold">{receipt.school_name}</p>
            <p className="text-center text-slate-500">Fee Receipt</p>
            <dl className="mt-4 space-y-1.5">
              <div className="flex justify-between"><dt className="text-slate-500">Receipt no.</dt><dd className="font-mono">{receipt.receipt_no}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Student</dt><dd className="font-medium">{receipt.student_name}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Class</dt><dd>{receipt.class_name}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Month</dt><dd>{monthName(receipt.month)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Amount due</dt><dd>{fmtPKR(receipt.amount_due)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Discount</dt><dd>{fmtPKR(receipt.discount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Amount paid</dt><dd className="font-bold">{fmtPKR(receipt.amount_paid)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Payment method</dt><dd>{receipt.payment_method ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Paid at</dt><dd>{receipt.paid_at ?? '—'}</dd></div>
            </dl>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => window.print()}>Print receipt</Button>
            <Button onClick={() => setReceipt(null)}>Close</Button>
          </div>
        </Modal>
      )}
      {editingStructure && (
        <StructureModal
          structure={editingStructure === 'new' ? null : editingStructure}
          classes={classes}
          takenClassIds={new Set(structures.map((s) => s.class_id))}
          onClose={() => setEditingStructure(null)}
          onDone={(queued) => {
            setEditingStructure(null);
            push('success', queued ? 'Submitted for admin approval — nothing was applied yet.' : 'Fee structure saved.');
            load();
          }}
        />
      )}

      {deletingStructure && (
        <ConfirmDialog
          open
          title="Delete this fee structure?"
          message={`Delete the fee structure for Class ${deletingStructure.class_name ?? '—'}? A structure that already produced fee records cannot be deleted — those records stay untouched.`}
          confirmLabel="Delete structure"
          tone="danger"
          onConfirm={async () => {
            try {
              await api(`/fees/structures/${deletingStructure.id}`, { method: 'DELETE' });
              push('success', 'Fee structure deleted.');
              setDeletingStructure(null);
              load();
            } catch (e) {
              push('error', errText(e));
            }
          }}
          onCancel={() => setDeletingStructure(null)}
        />
      )}
      {view}
    </div>
  );
}

interface ReceiptData {
  receipt_no: string;
  school_name: string;
  student_name: string;
  class_name: string;
  month: string;
  amount_due: number;
  amount_paid: number;
  discount: number;
  payment_method?: string | null;
  paid_at?: string | null;
}

function StructureModal({
  structure,
  classes,
  takenClassIds,
  onClose,
  onDone,
}: {
  structure: FeeStructure | null;
  classes: ClassItem[];
  takenClassIds: Set<string>;
  onClose: () => void;
  onDone: (queued: boolean) => void;
}) {
  const availableClasses = structure
    ? classes.filter((c) => c.id === structure.class_id)
    : classes.filter((c) => !takenClassIds.has(c.id));
  const [classId, setClassId] = useState(structure?.class_id ?? availableClasses[0]?.id ?? '');
  const [monthlyAmount, setMonthlyAmount] = useState(structure ? String(structure.monthly_amount) : '');
  const [admissionFee, setAdmissionFee] = useState(structure ? String(structure.admission_fee ?? 0) : '0');
  const [siblingPct, setSiblingPct] = useState(structure ? String(structure.sibling_discount_pct ?? 0) : '0');
  const [effectiveFrom, setEffectiveFrom] = useState(structure?.effective_from ?? todayISO());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const amount = Number(monthlyAmount);
    const admission = Number(admissionFee);
    const sibling = Number(siblingPct);
    if (!classId) {
      setError('Pick a class first.');
      return;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      setError('Monthly amount must be a whole number greater than 0.');
      return;
    }
    if (!Number.isInteger(admission) || admission < 0) {
      setError('Admission fee must be a whole number of 0 or more.');
      return;
    }
    if (!Number.isInteger(sibling) || sibling < 0 || sibling > 100) {
      setError('Sibling discount must be a whole number from 0 to 100.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setError('Effective-from must be a valid date.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        class_id: classId,
        monthly_amount: amount,
        admission_fee: admission,
        sibling_discount_pct: sibling,
        effective_from: effectiveFrom,
      };
      const res = structure
        ? await api<Record<string, unknown>>(`/fees/structures/${structure.id}`, { method: 'PATCH', body })
        : await api<Record<string, unknown>>('/fees/structures', { method: 'POST', body });
      // Clerks go through the approval queue (202): the response carries
      // approval_request_id instead of the created structure.
      onDone(typeof res === 'object' && res !== null && 'approval_request_id' in res);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={structure ? `Edit fee structure — Class ${structure.class_name ?? ''}` : 'Add fee structure'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      {availableClasses.length === 0 && !structure ? (
        <EmptyState
          title="No class left to price"
          body="Every class already has a fee structure. Add a new class first, or edit an existing structure."
          actionLabel="Add a class"
          actionHref="/classes"
        />
      ) : (
        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <Field label="Class">
            {structure ? (
              <input className={inputCls} value={`Class ${structure.class_name ?? ''}`} disabled />
            ) : (
              <select className={inputCls} value={classId} onChange={(e) => setClassId(e.target.value)}>
                {availableClasses.map((c) => (
                  <option key={c.id} value={c.id}>
                    Class {c.name}-{c.section}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Monthly amount (PKR)">
            <input className={inputCls} type="number" min={1} step={1} required value={monthlyAmount} onChange={(e) => setMonthlyAmount(e.target.value)} placeholder="e.g. 2500" autoComplete="off" />
          </Field>
          <Field label="Admission fee (PKR, one-time)" hint="Added only to a student's first fee record. Enter 0 for none.">
            <input className={inputCls} type="number" min={0} step={1} value={admissionFee} onChange={(e) => setAdmissionFee(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Sibling discount (%)" hint="Discount for families with two or more children in the school. Enter 0 for none.">
            <input className={inputCls} type="number" min={0} max={100} step={1} value={siblingPct} onChange={(e) => setSiblingPct(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Effective from">
            <input className={inputCls} type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} autoComplete="off" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : structure ? 'Save changes' : 'Add structure'}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function PayModal({
  fee,
  month,
  onClose,
  onDone,
}: {
  fee: FeeRow;
  month: string;
  onClose: () => void;
  onDone: (receiptNo: string) => void;
}) {
  const remaining = fee.amount_due - fee.amount_paid - fee.discount;
  // Blank by design (frontend hardening): no pre-filled amount — the
  // remaining balance is shown as a hint, never entered for the user.
  const [amount, setAmount] = useState('');
  const [discount, setDiscount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const paid = Number(amount);
    if (Number.isNaN(paid) || paid <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    setConfirming(true);
  };

  const doPay = async () => {
    const paid = Number(amount);
    setBusy(true);
    setConfirming(false);
    try {
      const res = await api<{ receipt_no: string }>(`/fees/${fee.student_id}/pay`, {
        method: 'POST',
        body: { month, amount_paid: paid, discount: Number(discount) || 0, payment_method: method },
      });
      onDone(res.receipt_no);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Mark fee paid — ${fee.student_name}`} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <p className="mb-4 text-sm text-slate-600">
        Class {fee.class_name} · {monthName(month)} · Due {fmtPKR(fee.amount_due)} · Already paid {fmtPKR(fee.amount_paid)} ·{' '}
        <strong>Remaining {fmtPKR(Math.max(0, remaining))}</strong>
      </p>
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <Field label="Amount paid (PKR)" hint={`Partial payments are allowed — the status updates automatically. Remaining: ${fmtPKR(Math.max(0, remaining))}.`}>
          <input className={inputCls} type="number" min={1} required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Enter amount received" autoComplete="off" />
        </Field>
        <Field label="Discount (PKR)">
          <input className={inputCls} type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0 if no discount" autoComplete="off" />
          {/* P8-TOUR: sibling discount, explained in plain words. */}
          <span className="mt-1 flex items-center text-xs text-slate-500">
            Giving a sibling discount?
            <Tooltip text="A sibling discount is a reduction for families with two or more children in the school. Enter that reduction here — it is taken off the amount due." />
          </span>
        </Field>
        <Field label="Payment method">
          <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>Cash</option>
            <option>JazzCash</option>
            <option>Easypaisa</option>
            <option>Bank transfer</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record payment'}</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title="Record this payment?"
        message={`Are you sure? This will record a payment of PKR ${Number(amount) || 0} for ${fee.student_name} (Class ${fee.class_name}, ${monthName(month)})${Number(discount) ? ` with a discount of PKR ${Number(discount)}` : ''}, via ${method}. This cannot be undone from here.`}
        confirmLabel="Confirm payment"
        tone="primary"
        busy={busy}
        onConfirm={doPay}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
}
