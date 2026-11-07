// Fee module shared types.
// Money is integer PKR everywhere. Status is derived from amounts
// (see computeFeeStatus in service.ts) and mirrors the contract's
// GENERATED status column semantics.

export type FeeStatus = 'unpaid' | 'partial' | 'paid';

export interface PayFeeInput {
  month: string; // YYYY-MM
  amount_paid: number; // PKR, integer > 0
  discount?: number; // PKR, integer >= 0, default 0
  payment_method?: string; // e.g. 'cash' | 'jazzcash' | 'easypaisa' | 'bank'
  receipt?: string; // optional payer reference / note (stored on audit log, not a column)
  arrears?: number; // PKR carried from prior months — folded into amount_due at record creation (v2)
  scholarship_discount?: number; // PKR — folded into amount_due at record creation (v2)
}

export interface FeeStructureInput {
  class_id: string;
  monthly_amount: number; // PKR, integer > 0
  effective_from: string; // YYYY-MM-DD
  admission_fee?: number; // PKR, one-time, integer >= 0 (v2)
  sibling_discount_pct?: number; // 0–100 (v2)
}

export interface FeeBreakdownView {
  monthly_amount: number;
  arrears: number;
  admission_fee: number;
  sibling_discount: number;
  scholarship_discount: number;
  amount_due: number;
}

export interface FeeListItem {
  student_id: string;
  student_name: string;
  roll_no: number | null;
  class_id: string;
  class_name: string; // e.g. '5-A'
  month: string;
  amount_due: number;
  amount_paid: number;
  discount: number;
  arrears: number; // carried-forward balance from earlier months (stored on the record)
  scholarship_discount: number; // PKR folded into amount_due at creation
  /** Prospective breakdown — only for rows with no fee_record yet. */
  breakdown: FeeBreakdownView | null;
  balance: number;
  status: FeeStatus;
  receipt_no: string | null;
  paid_at: string | null;
  payment_method: string | null;
  record_exists: boolean;
  record_id: string | null; // fee_record id (null until a record exists) — used for vouchers
  no_structure: boolean; // true when no fee structure covers this class/month
}

export interface FeeListTotals {
  /** Whole-month sums over ALL matching rows (not just the returned page) —
   * the Fees page cards must not change when the admin turns the page. */
  collected: number;
  pending: number;
  paid_count: number;
  unpaid_count: number;
}

export interface FeeListResult {
  items: FeeListItem[];
  total: number;
  page: number;
  pages: number;
  month: string;
  totals: FeeListTotals;
}

export interface ReceiptData {
  receipt_no: string;
  school_name: string;
  school_slug: string;
  student_id: string;
  student_name: string;
  roll_no: number | null;
  class_name: string;
  month: string;
  amount_due: number;
  discount: number;
  amount_paid: number;
  balance: number;
  status: FeeStatus;
  payment_method: string | null;
  paid_at: string | null;
  issued_at: string; // ISO timestamp of receipt generation
  arrears: number; // carried-forward dues included in amount_due
  scholarship_discount: number; // scholarship folded into amount_due
}

export interface FeeStructureView {
  id: string;
  class_id: string;
  class_name: string;
  monthly_amount: number;
  admission_fee: number;
  sibling_discount_pct: number;
  effective_from: string; // YYYY-MM-DD
  created_at: string;
  /** Current-month records created by the creation backfill (create only). */
  backfilled_records?: number;
}

export interface MonthlyFeeReport {
  month: string;
  collected: number;
  pending: number;
  total_due: number;
  paid_count: number;
  partial_count: number;
  unpaid_count: number;
  missing_records: number; // active students with no fee_record this month
  by_class: Array<{
    class_id: string;
    class_name: string;
    collected: number;
    pending: number;
    total_due: number;
    paid_count: number;
    partial_count: number;
    unpaid_count: number;
    missing_records: number;
  }>;
}

export interface RolloverResult {
  month: string;
  created: number;
  already_existed: number;
  classes_without_structure: string[]; // class ids skipped (no structure)
}
