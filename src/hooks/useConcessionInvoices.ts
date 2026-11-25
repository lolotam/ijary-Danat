import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import { assertNotRowCapped, fetchInChunks } from "@/lib/idChunks";
import { PERMISSIONS } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export type DiscountableInvoice = {
  id: string;
  code: string;
  period_year: number;
  period_month: number;
  /** إجمالي الفاتورة قبل الخصم. */
  subtotal: number;
  /** مجموع بنود المصروفات الدورية على هذه الفاتورة (migration 169). */
  extraCharges: number;
};

/**
 * الفواتير غير المدفوعة بالكامل على هذا العقد التي لا تحمل خصماً بعد.
 *
 * The dropdown filter is a usability measure. unique (invoice_id) is the
 * guarantee — an invoice already linked by another concession stays out of
 * this list until that concession is deleted.
 */
export async function fetchDiscountableInvoices(
  contractId: string,
): Promise<DiscountableInvoice[]> {
  const invoices = await supabase
    .from("invoices")
    .select("id, code, period_year, period_month, paid, state, discount, subtotal")
    .eq("contract_id", contractId)
    .in("state", ["due", "overdue"])
    .order("period_year")
    .order("period_month");
  if (invoices.error) throw invoices.error;
  // Unranged, so the server caps it. 238 is the widest contract today against a
  // limit of 1,000, but a dropdown that quietly omits the months past the cap
  // would send an admin looking for a missing invoice rather than a bug.
  assertNotRowCapped(invoices.data, "The contract's unpaid invoices");

  const unpaid = invoices.data.filter(
    (row) => Number(row.paid ?? 0) === 0 && Number(row.discount ?? 0) === 0,
  );
  if (!unpaid.length) return [];

  // Chunked: a twenty-year lease leaves 238 invoices unpaid, and one `in()`
  // filter that wide overruns the gateway URL limit. The 414 surfaced as an
  // empty dropdown reading "no unpaid invoices on this contract" — a failure
  // shown as a fact, which is why it went unnoticed.
  const linked = await fetchInChunks(
    unpaid.map((row) => row.id),
    (chunk) => supabase.from("concession_invoices").select("invoice_id").in("invoice_id", chunk),
  );
  const taken = new Set(linked.map((row) => row.invoice_id));
  const offered = unpaid.filter((row) => !taken.has(row.id));
  if (!offered.length) return [];

  // Service-charge totals, so the caller can tell which of these months would
  // still owe something after a full discount. Chunked for the same reason the
  // link lookup is, and it matters more here: this reads invoice ITEMS, several
  // rows per invoice, so it hits a row cap far sooner than the invoice list
  // above. A total short by a truncated page reads as "this month has no
  // service charges", which hides the waiver prompt and bills them silently —
  // the failure shown as a fact, again.
  const extraRows = await fetchInChunks(
    offered.map((row) => row.id),
    (chunk) =>
      supabase
        .from("invoice_items")
        .select("invoice_id, amount")
        .eq("is_extra_charge", true)
        .in("invoice_id", chunk),
  );
  const extrasByInvoice = new Map<string, number>();
  for (const row of extraRows) {
    extrasByInvoice.set(
      row.invoice_id,
      (extrasByInvoice.get(row.invoice_id) ?? 0) + Number(row.amount),
    );
  }

  return offered.map((row) => ({
    id: row.id,
    code: row.code,
    period_year: row.period_year,
    period_month: row.period_month,
    subtotal: Number(row.subtotal ?? 0),
    extraCharges: extrasByInvoice.get(row.id) ?? 0,
  }));
}

export function useDiscountableInvoices(contractId: string | null) {
  return useQuery({
    queryKey: ["discountable-invoices", contractId],
    enabled: Boolean(contractId),
    queryFn: () => fetchDiscountableInvoices(contractId!),
  });
}

export type ConcessionInvoiceCoverage = {
  codes: string[];
  months: number;
  /**
   * Money actually taken off, summed across the concession's linked invoices.
   *
   * A sum, not the configured `discount_amount` or a figure recomputed from
   * `discount_percent`. `apply_concession_to_invoices` applies a fixed discount
   * to *each* invoice it binds — 50 KWD across three months is 150 KWD off, not
   * 50 — and clamps every one at the invoice's own subtotal. Only the total of
   * what it wrote to `invoices.discount` describes what the tenant was actually
   * relieved of.
   */
  discountTotal: number;
};

/** أقل ما يلزم من الفاتورة لبناء تغطية التنازل: رمزها وقيمة خصمها. */
export interface CoverageInvoice {
  id: string;
  code: string;
  discount: number | null;
}

/**
 * يجمع فواتير كل تنازل: رموزها، وعددها، وإجمالي الخصم المطبَّق عليها.
 *
 * Pure so the grouping can be tested without a database. `months` counts links
 * rather than calendar months — `ConcessionsTable.monthsFor` prefers it over
 * the date range precisely because a discount bound to January and March
 * covers two invoices, not three months.
 *
 * An invoice missing from `invoices` still counts toward `months` but
 * contributes no code and no money: the link is the fact, the invoice row is
 * only how it is described.
 */
export function buildConcessionCoverage(
  links: ReadonlyArray<{ concession_id: string; invoice_id: string }>,
  invoices: ReadonlyArray<CoverageInvoice>,
): Map<string, ConcessionInvoiceCoverage> {
  const invoiceById = new Map(invoices.map((row) => [row.id, row]));
  const coverage = new Map<string, ConcessionInvoiceCoverage>();
  for (const link of links) {
    const invoice = invoiceById.get(link.invoice_id);
    const current = coverage.get(link.concession_id) ?? { codes: [], months: 0, discountTotal: 0 };
    if (invoice) {
      current.codes.push(invoice.code);
      // Numerics arrive from PostgREST as strings; adding one without coercion
      // turns the total into concatenated digits.
      current.discountTotal += Number(invoice.discount ?? 0);
    }
    current.months += 1;
    coverage.set(link.concession_id, current);
  }
  return coverage;
}

/**
 * رموز الفواتير المرتبطة بكل تنازل على العقد وإجمالي خصمها، لجدول الحوار.
 */
export function useConcessionInvoiceCoverage(contractId: string | null) {
  return useQuery({
    queryKey: ["concession-invoice-coverage", contractId],
    enabled: Boolean(contractId),
    queryFn: async (): Promise<Map<string, ConcessionInvoiceCoverage>> => {
      const concessions = await supabase
        .from("concessions")
        .select("id")
        .eq("contract_id", contractId!);
      if (concessions.error) throw concessions.error;
      const concessionIds = concessions.data.map((row) => row.id);
      if (!concessionIds.length) return new Map();

      const links = await supabase
        .from("concession_invoices")
        .select("concession_id, invoice_id")
        .in("concession_id", concessionIds);
      if (links.error) throw links.error;
      // Also unranged: a clipped list here understates both the month count and
      // the discount total the table reports, which is a money figure.
      assertNotRowCapped(links.data, "The contract's concession links");
      if (!links.data.length) return new Map();

      const invoiceIds = [...new Set(links.data.map((row) => row.invoice_id))];
      const invoices = await fetchInChunks(invoiceIds, (chunk) =>
        supabase.from("invoices").select("id, code, discount").in("id", chunk),
      );

      return buildConcessionCoverage(links.data, invoices);
    },
  });
}

/**
 * يربط تنازلاً بنسبة أو مبلغ ثابت بفواتير محددة عبر RPC الحارس.
 */
export function useApplyConcessionToInvoices() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      concessionId,
      invoiceIds,
      waiveExtraChargeInvoiceIds = [],
    }: {
      concessionId: string;
      invoiceIds: string[];
      /**
       * الفواتير التي وافق المسؤول على إسقاط مصروفاتها الدورية أيضاً.
       *
       * A proposal, not an instruction. The function re-derives every condition
       * under the row lock and ignores an id whose invoice no longer qualifies,
       * so a stale screen cannot waive a charge on a month it misread.
       */
      waiveExtraChargeInvoiceIds?: string[];
    }) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_UPDATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.rpc("apply_concession_to_invoices", {
        p_concession_id: concessionId,
        p_invoice_ids: invoiceIds,
        p_waive_extra_charge_invoice_ids: waiveExtraChargeInvoiceIds,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concessions"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["discountable-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["concession-invoice-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      void invalidatePortalViews(queryClient);
    },
  });
}

/**
 * يصيغ صف الفاتورة في قائمة الاختيار: الرمز ثم الشهر والسنة المحليّان.
 */
export function formatDiscountableInvoiceLabel(
  invoice: Pick<DiscountableInvoice, "code" | "period_year" | "period_month">,
  locale: string,
): string {
  const monthYear = new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en-GB", {
    month: "long",
    year: "numeric",
  }).format(new Date(invoice.period_year, invoice.period_month - 1, 1));
  return `${invoice.code} — ${monthYear}`;
}

/**
 * يشتق تاريخَي بداية ونهاية التنازل من فترات الفواتير المختارة.
 *
 * Existing table columns still read start_date/end_date; binding is the
 * concession_invoices rows, so a non-contiguous Jan+Mar span can cover those
 * two invoices without inventing a February discount.
 */
export function periodBoundsFromInvoices(
  invoices: Array<Pick<DiscountableInvoice, "period_year" | "period_month">>,
): { start_date: string; end_date: string } | null {
  if (!invoices.length) return null;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const invoice of invoices) {
    const start = new Date(invoice.period_year, invoice.period_month - 1, 1).getTime();
    const end = new Date(invoice.period_year, invoice.period_month, 0).getTime();
    if (start < minStart) minStart = start;
    if (end > maxEnd) maxEnd = end;
  }
  /**
   * يحوّل ختماً زمنياً إلى تاريخ ISO محلي دون إزاحة UTC.
   */
  function isoDate(value: number): string {
    const date = new Date(value);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }
  return { start_date: isoDate(minStart), end_date: isoDate(maxEnd) };
}
