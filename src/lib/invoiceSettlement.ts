import type { InvoiceState } from "@/integrations/supabase/database.types";
import { roundToFils } from "@/lib/fils";

/** Minimal invoice slice the settlement pure functions need — keeps callers free of full row types. */
export interface SettleableInvoice {
  id: string;
  balance: number;
  code: string;
  period_month: number;
  period_year: number;
  state: InvoiceState;
}

/** One confirmed payment + full allocation against a single invoice balance. */
export interface InvoiceSettlement {
  invoiceId: string;
  amount: number;
}

/**
 * يرجع فواتير العقد القابلة للتسوية مرتّبة من الأقدم إلى الأحدث.
 *
 * `apply_payment_allocation` rejects cancelled/waived invoices and any amount
 * above balance; zero-balance rows would only create empty payments. Filter and
 * order here so the admin picker never offers a row the RPC would refuse.
 * `code` is the tiebreaker because invoices generated in one batch share an
 * identical created_at and cannot be ordered by it.
 */
export function settleableInvoices(invoices: SettleableInvoice[]): SettleableInvoice[] {
  return invoices.filter(isOpenInvoice).sort(compareInvoicePeriod);
}

/** فاتورة مفتوحة للتسوية: فيها رصيد، وليست ملغاة ولا مشطوبة. */
function isOpenInvoice(invoice: Pick<SettleableInvoice, "balance" | "state">): boolean {
  return invoice.balance > 0 && invoice.state !== "cancelled" && invoice.state !== "waived";
}

/** الحقول التي يحتاجها ترتيب "الأقدم أولاً". */
type PeriodOrdered = { code: string; period_month: number; period_year: number };

/**
 * يقارن فاتورتين بالفترة (سنة ثم شهر) ثم برمز الفاتورة — ترتيب "الأقدم أولاً" الموحّد.
 *
 * One comparator for every screen that shows invoices in settlement order.
 * Audit H8 found three browser copies, two with no tiebreak at all, so two
 * invoices in the same period sorted in arrival order — and a refetch could
 * make two screens name different "oldest" invoices for one contract. `code`
 * is the tiebreak because invoices generated in one batch share a created_at.
 */
export function compareInvoicePeriod(a: PeriodOrdered, b: PeriodOrdered): number {
  if (a.period_year !== b.period_year) return a.period_year - b.period_year;
  if (a.period_month !== b.period_month) return a.period_month - b.period_month;
  return a.code.localeCompare(b.code);
}

/** رقم الفترة (سنة × 12 + شهر) — فواتير الشهر نفسه تتساوى فيه، فلا يسبق أحدها الآخر. */
function periodIndex(invoice: Pick<SettleableInvoice, "period_month" | "period_year">): number {
  return invoice.period_year * 12 + invoice.period_month;
}

/**
 * يرجع أول فاتورة في التوزيع تُسدَّد قبل فاتورة أقدم ما زالت مفتوحة، أو null إن كان الترتيب سليماً.
 *
 * The server-side half of "settle the oldest first" (audit H8). The admin
 * dialog enforced it only in the browser. It now runs in the user-scoped
 * `applyAllocation` server fn, and migration 217 mirrors it inside
 * `apply_payment_allocation` for `authenticated` callers only — the MyFatoorah
 * webhook and the reconcile job call that RPC as `service_role`, and making it
 * raise for them would strand gateway money mid-webhook. Change this rule and
 * the SQL copy together.
 *
 * "Older" is the (year, month) tuple only, exactly as
 * `set_invoice_paid_chronological` (migration 129) compares it: a same-month
 * sibling is a peer, and a server stricter than the SQL authority would refuse
 * settlements the database accepts. An older invoice counts as cleared when
 * this same call pays its remaining balance, compared in whole fils so float
 * dust cannot block the next month.
 *
 * `openInvoices` must be every invoice of the contracts touched, not only the
 * allocated ones — an older month that nobody selected is the whole point. Each
 * target is judged against its OWN contract only, as migration 129 does: a
 * payment split across two contracts must not let one contract's arrears block
 * the other (Codex review, PR #220).
 */
export function findOutOfOrderAllocation(
  openInvoices: Array<SettleableInvoice & { contract_id?: string }>,
  allocations: ReadonlyArray<{ invoice_id: string; amount: number }>,
): string | null {
  const paidNow = new Map<string, number>();
  for (const allocation of allocations) {
    paidNow.set(
      allocation.invoice_id,
      (paidNow.get(allocation.invoice_id) ?? 0) + allocation.amount,
    );
  }
  const stillOpen = openInvoices.filter(
    (invoice) =>
      isOpenInvoice(invoice) &&
      Math.round((invoice.balance - (paidNow.get(invoice.id) ?? 0)) * 1000) > 0,
  );
  const byId = new Map(openInvoices.map((invoice) => [invoice.id, invoice]));
  for (const allocation of allocations) {
    const target = byId.get(allocation.invoice_id);
    if (!target) continue;
    const blocked = stillOpen.some(
      (older) =>
        older.id !== target.id &&
        older.contract_id === target.contract_id &&
        periodIndex(older) < periodIndex(target),
    );
    if (blocked) return target.id;
  }
  return null;
}

/**
 * One payment per invoice at full balance — free-typed partial amounts are how
 * invoices silently stay partially_paid. Rounding to 3 decimals matches KWD
 * fils and the money path in createPayment.ts.
 */
export function buildInvoiceSettlements(
  invoices: SettleableInvoice[],
  selectedIds: string[],
): InvoiceSettlement[] {
  const settleable = settleableInvoices(invoices);
  const selected = new Set(selectedIds);
  return settleable
    .filter((invoice) => selected.has(invoice.id))
    .map((invoice) => ({
      invoiceId: invoice.id,
      amount: roundToFils(invoice.balance),
    }));
}

/**
 * KWD is three decimal places; bare float sums like 0.1+0.2 drift off the
 * money columns the allocation RPC compares against.
 */
export function settlementTotal(settlements: InvoiceSettlement[]): number {
  return roundToFils(settlements.reduce((sum, settlement) => sum + settlement.amount, 0));
}

/** الحد الأدنى الذي تحتاجه قواعد الاختيار: المعرّف فقط. */
type SelectableRow = { id: string };

/**
 * يتحقق أن الفواتير المختارة تشكّل بادئة متصلة من الأقدم فالأحدث.
 *
 * The tenant portal enforces the same rule in three places — `is_selectable` in
 * `evaluate_portal_payable_invoices` (121:95), the checkbox in
 * portal.invoices.tsx:131, and `invoiceSelection` in createPayment.ts:266 — and
 * none of them is reusable here, because all three read the portal RPC, which
 * filters on `is_visible_to_tenant`. Staff may settle an invoice that is hidden
 * from the tenant, so the admin dialog needs the rule without that filter.
 *
 * Pure over an already-sorted array so it is testable without a database;
 * `settleableInvoices` is what guarantees the sort.
 */
export function isContiguousPrefix(ordered: SelectableRow[], selectedIds: string[]): boolean {
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) return false;
  if (selected.size > ordered.length) return false;
  return ordered.slice(0, selected.size).every((row) => selected.has(row.id));
}

/**
 * يعيد الاختيار الناتج عن تأشير الصف رقم `index`: كل ما قبله ومعه.
 *
 * Mirrors portal.invoices.tsx:139-146 exactly, so the two screens cannot drift.
 */
export function selectThrough(ordered: SelectableRow[], index: number): string[] {
  return ordered.slice(0, index + 1).map((row) => row.id);
}

/**
 * يعيد الاختيار الناتج عن إلغاء تأشير الصف رقم `index`: كل ما قبله فقط.
 */
export function deselectFrom(ordered: SelectableRow[], index: number): string[] {
  return ordered.slice(0, index).map((row) => row.id);
}

/**
 * رقم الصف الوحيد المسموح بتأشيره تاليًا؛ يساوي طول القائمة عند اختيار الكل.
 *
 * Falls back to the oldest row when the selection is not a valid prefix, so a
 * state the UI should never produce still leaves exactly one legal move rather
 * than locking every checkbox.
 */
export function nextSelectableIndex(ordered: SelectableRow[], selectedIds: string[]): number {
  return isContiguousPrefix(ordered, selectedIds) ? selectedIds.length : 0;
}
