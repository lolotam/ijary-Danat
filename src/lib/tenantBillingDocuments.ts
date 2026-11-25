/**
 * أقل ما يحتاجه إخفاء المستندات من صف العقد، حتى تبقى الدوال قابلة للاختبار بلا استعلام.
 *
 * The flag is optional here, not `boolean` as the table declares it, because
 * these functions also run over rows cached before migration 173 — a TanStack
 * Query entry filled by the previous bundle, or a browser tab left open across
 * the deploy.
 */
export interface TenantBillingContractRow {
  id: string;
  suppress_tenant_billing_docs?: boolean | null;
}

/**
 * الفواتير التي يجوز طباعتها للمستأجر بعد استبعاد عقود السطح.
 *
 * The portal's payment row documents a PAYMENT, not a single contract's slice
 * of it: one payment can settle invoices from a roof contract AND a shop
 * contract at once. Every one of those eight roof tenants also holds one to
 * four non-roof contracts, so hiding the whole row when it *touches* a roof
 * contract would rob the tenant of the paper for their ordinary shop invoices.
 *
 * Filtering is per-invoice: the document is built from the settled invoices
 * whose contract is NOT suppressed. Only when that leaves zero invoices does
 * the row render no actions at all.
 *
 * The suppression flag defaults OPEN: only an explicit `true` suppresses. An
 * absent or null value — today's rows, and a stale cache during the deploy
 * window — means "not suppressed". This is the opposite of the landing module
 * where only an explicit `false` hides, and that is deliberate: one is an
 * opt-in visibility, the other is an opt-in suppression.
 */
export function filterPrintableInvoices<T extends { contract_id: string | null | undefined }>(
  invoices: readonly T[],
  suppressedContractIds: ReadonlySet<string>,
): T[] {
  if (!suppressedContractIds.size) return [...invoices];
  return invoices.filter((invoice) => {
    const contractId = invoice.contract_id;
    if (!contractId) return true;
    return !suppressedContractIds.has(contractId);
  });
}

/**
 * يبني مجموعة معرّفات العقود المكبوتة من صفوف العقود.
 *
 * Only an explicit `true` enters the set. Treats absent / null / false as
 * not suppressed so a cache entry from before migration 173 keeps its paper
 * until the next fetch rather than vanishing the moment the new bundle loads.
 */
export function suppressedContractIdsFromRows(
  rows: readonly TenantBillingContractRow[],
): Set<string> {
  const suppressed = new Set<string>();
  for (const row of rows) {
    if (row.suppress_tenant_billing_docs === true) suppressed.add(row.id);
  }
  return suppressed;
}

/**
 * هل يجب أن يعرض صف الدفعة أزرار المستند (معاينة/طباعة/PDF)؟
 *
 * The portal renders one payment row per transaction. When every settled
 * invoice belongs to a suppressed contract, there is no paper to show and the
 * row renders no actions. When at least one settled invoice belongs to an
 * ordinary contract, the actions stay and the document will contain only those
 * ordinary invoices (see `filterPrintableInvoices`).
 *
 * An allocation-less payment has no invoice to read a contract from. Callers
 * resolve that case through the portal's currently selected contract and pass
 * the result as `isAllocationlessSuppressed` — see `portal.payments.tsx` for
 * how the portal already scopes by contract.
 */
export function shouldShowTenantBillingActions(input: {
  settledInvoices: readonly { contract_id: string | null | undefined }[];
  suppressedContractIds: ReadonlySet<string>;
  /** Pre-resolved suppression for the allocation-less fallback; null means not allocation-less. */
  isAllocationlessSuppressed?: boolean | null;
}): boolean {
  const { settledInvoices, suppressedContractIds, isAllocationlessSuppressed } = input;
  if (!settledInvoices.length) {
    // No allocations: decision rests on the selected contract alone when
    // the caller could resolve it, otherwise keep today's behaviour.
    if (isAllocationlessSuppressed === true) return false;
    return true;
  }
  return filterPrintableInvoices(settledInvoices, suppressedContractIds).length > 0;
}

/**
 * هل يجب كتم إشعار نجاح الدفع للمستأجر (بريد + واتساب + PDF)؟
 *
 * Deliberately DIFFERENT granularity from the portal rule. `renderPaymentReceiptPdfs`
 * renders ONE document per PAYMENT covering all its allocations (see
 * `src/lib/paymentReceiptPdf.ts:217-255`), so unlike the portal's per-invoice
 * pages it cannot be filtered down. The only way to guarantee no roof receipt
 * reaches the tenant is to drop the whole tenant notification for that payment
 * when ANY settled invoice belongs to a suppressed contract.
 *
 * Admin and company notifications for the same payment are unaffected — this
 * answers only the tenant block.
 */
export function shouldSuppressTenantNotification(input: {
  settledInvoices: readonly { contract_id: string | null | undefined }[];
  suppressedContractIds: ReadonlySet<string>;
}): boolean {
  if (!input.settledInvoices.length) return false;
  for (const invoice of input.settledInvoices) {
    const contractId = invoice.contract_id;
    if (contractId && input.suppressedContractIds.has(contractId)) return true;
  }
  return false;
}
