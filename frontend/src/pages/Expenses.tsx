// Expenses (6C-2) — CRUD + income-vs-expense summary for the month.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { PageResult } from '../lib/types';
import { currentMonth, fmtPKR, todayISO } from '../lib/utils';
import { Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import { useLanguage } from '../lib/i18n';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface Expense {
  id: string;
  date: string;
  category: string;
  description: string | null;
  paid_by: string | null;
  amount: number;
}

interface IncomeExpense {
  month: string;
  income: number;
  expense: number;
  balance: number;
  by_category: { category: string; total: number; count: number }[];
}

export default function ExpensesPage() {
  const { title } = useLanguage();
  const [month, setMonth] = useState(currentMonth());
  const [items, setItems] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<IncomeExpense | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [date, setDate] = useState(todayISO());
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<Expense>>(`/expenses?month=${month}&limit=200`),
      api<IncomeExpense>(`/expenses/report/income-expense?month=${month}`),
    ])
      .then(([e, s]) => {
        setItems(e.items);
        setSummary(s);
        setError('');
      })
      .catch(() => setError('Could not load expenses.'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(load, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const n = Number(amount);
    if (!category.trim() || Number.isNaN(n) || n <= 0) {
      setError('Enter a category and an amount greater than 0.');
      return;
    }
    setConfirming(true);
  };

  const doCreate = async () => {
    setBusy(true);
    setConfirming(false);
    try {
      await api('/expenses', {
        method: 'POST',
        body: { date, category: category.trim(), description: description.trim() || undefined, paid_by: paidBy.trim() || undefined, amount: Number(amount) },
      });
      push('success', 'Expense recorded.');
      setCategory('');
      setDescription('');
      setPaidBy('');
      setAmount('');
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/expenses/${deleting.id}`, { method: 'DELETE' });
      push('success', 'Expense deleted.');
      setDeleting(null);
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading expenses…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{title('expenses')}</h1>
          <p className="text-sm text-slate-500">Record what the school spends, and compare it with the fees collected.</p>
        </div>
        <input type="month" className={inputCls + ' w-auto'} value={month} onChange={(e) => setMonth(e.target.value || currentMonth())} autoComplete="off" />
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {summary && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Fees collected</p>
            <p className="mt-1 text-2xl font-bold text-brand-700">{fmtPKR(summary.income)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Expenses</p>
            <p className="mt-1 text-2xl font-bold text-red-600">{fmtPKR(summary.expense)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Balance</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{fmtPKR(summary.balance)}</p>
          </Card>
        </div>
      )}

      <Card className="p-5">
        <h2 className="text-base font-semibold">Add an expense</h2>
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2" autoComplete="off">
          <Field label="Date">
            <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())} autoComplete="off" />
          </Field>
          <Field label="Category">
            <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Utilities, Stationery, Salaries" autoComplete="off" />
          </Field>
          <Field label="Note">
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was this for?" autoComplete="off" />
          </Field>
          <Field label="Paid by">
            <input className={inputCls} value={paidBy} onChange={(e) => setPaidBy(e.target.value)} placeholder="Who paid (optional)" autoComplete="off" />
          </Field>
          <Field label="Amount (PKR)">
            <input className={inputCls} type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Enter amount" autoComplete="off" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add expense'}</Button>
          </div>
        </form>
      </Card>

      {items.length === 0 ? (
        <EmptyState title="No expenses this month" body="Record the school's spending here — electricity, stationery, repairs, anything." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Note</th>
                <th className="px-4 py-3">Paid by</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((x) => (
                <tr key={x.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">{x.date}</td>
                  <td className="px-4 py-2.5 font-medium">{x.category}</td>
                  <td className="px-4 py-2.5">{x.description ?? '—'}</td>
                  <td className="px-4 py-2.5">{x.paid_by ?? '—'}</td>
                  <td className="px-4 py-2.5">{fmtPKR(x.amount)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button className="font-medium text-red-600 hover:underline" onClick={() => setDeleting(x)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="Add this expense?"
        message={`Are you sure? This will record an expense of PKR ${Number(amount) || 0} for ${category.trim() || '(no category)'} on ${date}.`}
        confirmLabel="Add expense"
        tone="primary"
        busy={busy}
        onConfirm={doCreate}
        onCancel={() => setConfirming(false)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this expense?"
        message={deleting ? `Are you sure? This will delete the ${deleting.category} expense of PKR ${deleting.amount} on ${deleting.date}. This cannot be undone.` : ''}
        confirmLabel="Delete expense"
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
      {view}
    </div>
  );
}
