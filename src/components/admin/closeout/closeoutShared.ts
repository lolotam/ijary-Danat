/** إجراءات الفاتورة غير المسددة المتاحة عند الإغلاق. */
export const INVOICE_ACTIONS = [
  "leave",
  "settle_from_deposit",
  "write_off",
  "cancel",
  "mark_disputed",
] as const;

/** أنواع الخصومات من التأمين. */
export const DEDUCTION_KINDS = [
  "damages",
  "cleaning",
  "utilities",
  "unpaid_rent",
  "other",
] as const;

/** ما يعيده الإغلاق الناجح من الخادم. */
export type CloseoutResult = {
  closeout_id?: string;
  contract_code?: string;
  contract_state?: string;
  refund_code?: string | null;
  refund_id?: string | null;
  refund_total?: number;
  balance_due_tenant?: number;
  archived_at?: string | null;
};

/** معاينة التسوية كما يحسبها الخادم — لا حساب مالي في المتصفح. */
export type PreviewResult = {
  deposit_held?: number;
  deductions_total?: number;
  settled_total?: number;
  written_off_total?: number;
  refund_total?: number;
  balance_due_tenant?: number;
  available?: number;
};

/** يحوّل قيمة مالية قادمة من الخادم إلى رقم، والفارغ إلى صفر. */
export function num(value: unknown): number {
  return Number(value ?? 0);
}
