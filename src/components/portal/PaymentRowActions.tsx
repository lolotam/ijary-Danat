import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Eye, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Company } from "@/hooks/useCompany";
import { fetchPaymentAllocations, paymentAllocationsKey } from "@/hooks/usePaymentAllocations";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import { fetchReceipts, receiptsKey, type ReceiptListItem } from "@/hooks/useReceipts";
import { fetchInvoicesWithRelations } from "@/hooks/useInvoices";
import { fetchInvoicePaymentBreakdown } from "@/hooks/useInvoicePaymentBreakdown";
import { useI18n } from "@/i18n/provider";
import type { Locale } from "@/i18n/dictionary";
import type { Tables } from "@/integrations/supabase/database.types";
import {
  buildPaymentDocument,
  hasWithheldAllocations,
  settledInvoicesOf,
} from "@/lib/paymentPrintDocument";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import type { PartyNameTenant } from "@/lib/partyName";
import { downloadHtmlAsPdf, openLoadedDocument } from "@/lib/printDocument";
import { fetchSuppressedContractIds, suppressedContractsKey } from "@/hooks/useSuppressedContracts";
import { filterPrintableInvoices } from "@/lib/tenantBillingDocuments";

/**
 * Preview / Print / Download (PDF) actions for a single portal payment row.
 *
 * The document a payment row prints is the **invoice paper itself** — the
 * exact document the Monthly Invoices section prints, through the same builder
 * — because that is the paper the tenant files and the one the business signed
 * off on. A payment that settled several invoices prints each of them, one
 * page per invoice, in a single document. Only a payment with no invoice
 * allocations falls back to the payment-receipt document.
 */
export function PaymentRowActions({
  payment,
  company,
  tenant,
  suppressedContractIds,
  selectedContractId,
}: {
  payment: Tables<"payments">;
  company: Company | null;
  tenant?: PartyNameTenant | null;
  /**
   * Required, not optional, and deliberately so: an optional prop would let a
   * future call site omit it and silently default to showing every document.
   * The safe default for a suppression rule cannot be "off".
   */
  suppressedContractIds: ReadonlySet<string>;
  selectedContractId: string | null;
}) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  /**
   * يجلب تخصيصات الدفعة وإيصالها عند الضغط، والتخصيصات تُقرأ طازجة دائمًا.
   *
   * Lazily loaded at click time — the payments table would otherwise fan out
   * two queries per row on mount. Both go through `fetchQuery` (not a hook) so
   * the handler receives them as return values.
   *
   * The allocations pin `staleTime: 0` because `hasWithheldAllocations` reads
   * them as a permission answer, not as display data: whether the invoice
   * behind each allocation is still readable under tenant RLS. They inherit
   * the router's shared 30-second `staleTime` otherwise (`src/router.tsx`), so
   * a tenant who opens a document, has an admin hide the contract, and clicks
   * again inside that window would be re-served the cached row with its
   * now-withheld invoice still attached — the gate sees a resolvable invoice
   * and prints the paper. A gate cannot be evaluated against a snapshot taken
   * before the thing it guards against happened.
   *
   * The receipt keeps the shared cache: it feeds only the fallback document (a
   * payment with no allocations at all), where it heads the page. Without it
   * the portal printed the payment code while the office copy printed the
   * receipt code, so the same payment reached the tenant under two different
   * numbers. RLS returns nothing when the receipt is not `visible_to_tenant`,
   * and the payment code stands in — the previous behaviour, kept as the
   * fallback. Nothing gates on it, so its freshness decides nothing.
   */
  const loadDocumentData = (): Promise<[AllocationWithInvoice[], ReceiptListItem[]]> =>
    Promise.all([
      queryClient.fetchQuery({
        queryKey: paymentAllocationsKey(payment.id),
        queryFn: () => fetchPaymentAllocations(payment.id),
        staleTime: 0,
      }),
      queryClient.fetchQuery({
        queryKey: receiptsKey(payment.id),
        queryFn: () => fetchReceipts(payment.id),
      }),
    ]);

  /**
   * يبني مستند الدفعة: ورقة الفاتورة نفسها إن سدّدت فواتير، وإلا إيصال الدفعة.
   *
   * Enriching the settled invoices (tenant, units, properties) re-uses the
   * admin list's own fetcher, so the document is assembled from the same rows
   * the Monthly Invoices section assembles its copy from — same fields, same
   * order, same paper. RLS scopes every query to the signed-in tenant.
   */
  const buildDoc = async ([allocations, receipts]: [
    AllocationWithInvoice[],
    ReceiptListItem[],
  ]) => {
    const settledInvoices = settledInvoicesOf(allocations);

    // Allocations this tenant may read, pointing at invoices they may not.
    // `settledInvoicesOf` drops an allocation whose invoice came back null, so
    // this is the click-time form of the same rule the row gate applies at
    // render time — and it is the one that survives a stale cache. An admin can
    // hide a contract after this page rendered; focus refetching is off, so
    // `contractIds` still looks populated and the gate stays open, and
    // `buildPaymentDocument` would then take these for no allocations at all
    // and fall back to a generated receipt carrying their amounts.
    //
    // Only the total case refuses. A payment settling one readable invoice and
    // one hidden one still prints the readable half, which is the per-invoice
    // filtering migration 173 deliberately chose.
    if (hasWithheldAllocations(allocations)) return null;

    // Re-read the suppressed set at CLICK time rather than trusting the prop.
    // The prop is a render-time snapshot, and an admin enabling suppression in
    // their own session cannot invalidate this tenant's cache — focus
    // refetching is off — so a tab left open would keep printing paper that is
    // no longer allowed. `staleTime: 0` forces the round trip; the prop still
    // decides whether the buttons render at all, which stays cheap.
    // Fail CLOSED when the refresh fails: produce no document at all. Falling
    // back to the render-time prop was the earlier attempt and it is wrong for
    // the case that matters — an admin enables suppression after this page
    // rendered, the refresh then fails, and the stale prop does not contain the
    // newly suppressed contract, so the invoice would print. The snapshot is
    // exactly the thing we could not trust; it cannot be the fallback for
    // failing to replace it.
    let currentlySuppressed: ReadonlySet<string>;
    try {
      currentlySuppressed = await queryClient.fetchQuery({
        queryKey: suppressedContractsKey(payment.tenant_id),
        queryFn: () => fetchSuppressedContractIds(payment.tenant_id),
        staleTime: 0,
      });
    } catch {
      return null;
    }

    const printableInvoices = currentlySuppressed.size
      ? filterPrintableInvoices(settledInvoices, currentlySuppressed)
      : settledInvoices;

    const invoices = printableInvoices.length
      ? await fetchInvoicesWithRelations(printableInvoices)
      : [];

    // Allocation-less fallback has no invoice to read a contract from. Resolve
    // its contract through the portal's currently selected contract and
    // suppress it the same way. If there is no selected contract, keep today's
    // behaviour.
    if (
      currentlySuppressed.size &&
      selectedContractId &&
      currentlySuppressed.has(selectedContractId)
    ) {
      return null;
    }

    // Snapshots first, then the shared builder makes the invoice-or-receipt
    // choice — the one place it is written, so admin and portal cannot drift.
    const breakdowns = new Map<string, InvoicePaymentBreakdown>();
    for (const invoice of invoices) {
      breakdowns.set(invoice.id, await fetchInvoicePaymentBreakdown(invoice.id));
    }

    return buildPaymentDocument({
      allocations,
      company,
      invoices,
      breakdowns,
      invoiceFallbackTitle: t("invoices.printInvoice"),
      locale: locale as Locale,
      payment,
      receipt: receipts[0] ?? null,
      receiptFallbackTitle: t("receipts.title"),
      tenant,
    });
  };

  // Several round trips run before the paper exists, and iOS Safari spends
  // the tap on the first one: the window is claimed inside the tap and filled
  // afterwards (see `openLoadedDocument`). A suppressed document returns null
  // and the claimed window is closed again.
  const loadDoc = async () => buildDoc(await loadDocumentData());

  const runPreview = async () => {
    setBusy(true);
    try {
      const outcome = await openLoadedDocument(loadDoc, { autoPrint: false });
      if (outcome === "blocked") toast.error(t("common.popupBlocked"));
    } catch {
      toast.error(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const runPrint = async () => {
    setBusy(true);
    try {
      const outcome = await openLoadedDocument(loadDoc, { autoPrint: true });
      if (outcome === "blocked") toast.error(t("common.popupBlocked"));
    } catch {
      toast.error(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const runPdf = async () => {
    setBusy(true);
    try {
      const doc = await buildDoc(await loadDocumentData());
      if (!doc) return;
      const ok = await downloadHtmlAsPdf(doc.html, doc.filename, {
        title: doc.title,
        dir: doc.dir,
        extraCss: doc.extraCss,
      });
      if (ok) toast.success(t("common.pdfReady"));
      else toast.error(t("common.popupBlocked"));
    } catch {
      toast.error(t("common.pdfFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={t("common.preview")}
        aria-label={t("common.preview")}
        disabled={busy}
        onClick={runPreview}
      >
        <Eye className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={t("receipts.print")}
        aria-label={t("receipts.print")}
        disabled={busy}
        onClick={runPrint}
      >
        <Printer className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={t("common.downloadPdf")}
        aria-label={t("common.downloadPdf")}
        disabled={busy}
        onClick={runPdf}
      >
        <Download className="size-4" />
      </Button>
    </div>
  );
}
