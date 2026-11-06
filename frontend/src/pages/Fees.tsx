import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { FeeRow, FeeStructure, PageResult } from '../lib/types';
import { currentMonth, fmtPKR, monthName } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, Tabs, useToast } from '../components/ui';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

function statusBadge(s: FeeRow['status']) {
  if (s === 'paid') return <Badge tone="green">Paid</Badge>;
  if (s === 'partial') return <Badge tone="amber">Partial</Badge>;
  return <Badge tone="red">Unpaid</Badge>;
}

export default function FeesPage() {
  const [month, setMonth] = useState(currentMonth());
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'partial' | 'unpaid'>('all');
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [structures, setStructures] = useState<FeeStructure[]>([]);
  const [tab, setTab] = useState('fees');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState<FeeRow | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<FeeRow>>(`/fees?month=${month}&limit=200`),
      api<PageResult<FeeStructure>>('/fees/structures'),
    ])
      .then(([f, s]) => {
        setFees(f.items);
        setStructures(s.items);
        setError('');
      })
      .catch(() => setError('Could not load fees.'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(load, [load]);

  const filtered = fees.filter((f) => (statusFilter === 'all' ? true : f.status === statusFilter));
  const collected = fees.reduce((a, f) => a + f.amount_paid, 0);
  const pending = fees.reduce((a, f) => a + (f.amount_due - f.amount_paid - f.discount), 0);

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
          onChange={(e) => setMonth(e.target.value || currentMonth())}
        />
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
          <p className="mt-1 text-2xl font-bold text-slate-900">{fees.filter((f) => f.status === 'paid').length} / {fees.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Unpaid students</p>
          <p className="mt-1 text-2xl font-bold text-red-600">{fees.filter((f) => f.status === 'unpaid').length}</p>
        </Card>
      </div>

      <Tabs
        tabs={[
          { key: 'fees', label: 'Monthly fees' },
          { key: 'structures', label: 'Fee structures' },
          { key: 'report', label: 'Monthly report' },
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
            <EmptyState title="No fee records for this month" body="Fee records are created automatically at the start of each month from the fee structures." />
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
                      <td className="px-4 py-2.5">{fmtPKR(f.amount_due)}</td>
                      <td className="px-4 py-2.5">{fmtPKR(f.amount_paid)}</td>
                      <td className="px-4 py-2.5">{statusBadge(f.status)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{f.receipt_no ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        {f.status !== 'paid' ? (
                          <Button variant="secondary" onClick={() => setPaying(f)}>Mark paid</Button>
                        ) : (
                          <button
                            className="font-medium text-brand-700 hover:underline"
                            onClick={async () => {
                              try {
                                const r = await api<ReceiptData>(`/fees/receipts/${f.receipt_no}`);
                                setReceipt(r);
                              } catch (e) {
                                push('error', errText(e));
                              }
                            }}
                          >
                            Receipt
                          </button>
                        )}
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
          <h2 className="text-base font-semibold">Monthly fee per class</h2>
          <p className="mt-1 text-sm text-slate-500">
            New fee records are created from these structures at the start of each month. Paid records are never re-created.
          </p>
          <ul className="mt-4 divide-y divide-slate-100">
            {structures.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium">Class {s.class_name}</span>
                <span>
                  {fmtPKR(s.monthly_amount)} / month · from {s.effective_from}
                </span>
              </li>
            ))}
            {structures.length === 0 && <li className="py-2 text-sm text-slate-500">No fee structures yet.</li>}
          </ul>
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
        </Card>
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
              const r = await api<ReceiptData>(`/fees/receipts/${receiptNo}`);
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
  const [amount, setAmount] = useState(String(Math.max(0, remaining)));
  const [discount, setDiscount] = useState('0');
  const [method, setMethod] = useState('Cash');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const paid = Number(amount);
    if (Number.isNaN(paid) || paid <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    setBusy(true);
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
      <form onSubmit={submit} className="space-y-4">
        <Field label="Amount paid (PKR)" hint="Partial payments are allowed — the status updates automatically.">
          <input className={inputCls} type="number" min={1} required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Discount (PKR)">
          <input className={inputCls} type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} />
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
    </Modal>
  );
}
