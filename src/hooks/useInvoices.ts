import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import {
  loadInvoicesWithRelations,
  resolveUnitIdsByInvoice,
  type Invoice,
  type InvoiceWithRelations,
} from "@/lib/invoiceRelations";
import { supabase } from "@/integrations/supabase/client";
import type { InvoiceState, Tables } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchAllOffsetPages } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";
import { FINANCE_QUERY_OPTIONS } from "@/hooks/financeQueryOptions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/**
 * The invoice row, its relations and their loader all live in
 * `@/lib/invoiceRelations` now, so the server can load them with the
 * service-role client. Re-exported here because ~16 modules import them from
 * this hook.
 */
export type { Invoice, InvoiceWithRelations };
export { resolveUnitIdsByInvoice };

export interface InvoiceListParams {
  contractId?: string;
  /**
   * Return every matching invoice rather than one page. For screens that show
   * a whole contract or tenant at once and have no page control to reach the
   * rest — see `fetchAllOffsetPages` (formerly `fetchAllInvoicePages` here) for
   * why a page cap was the wrong shape there. Ignores `page` and `pageSize`.
   */
  fetchAll?: boolean;
  /**
   * When true, only invoices with disputed_at set. When false, only non-disputed.
   * Omit for no dispute filter. Archived-contract invoices are NEVER hidden by
   * default — use the row badge for disclosure; filtering is opt-in.
   */
  disputed?: boolean;
  overdue?: boolean;
  page?: number;
  pageSize?: number;
  periodMonth?: number;
  periodYear?: number;
  propertyId?: string;
  search?: string;
  sortAsc?: boolean;
  sortField?: string;
  state?: InvoiceState;
  tenantId?: string;
  unitId?: string;
}

/**
 * يجلب الفواتير مع علاقاتها باستخدام عميل المتصفح.
 *
 * A thin binding over {@link loadInvoicesWithRelations}: the enrichment itself
 * is client-agnostic so the emailed receipt renders from the same rows.
 */
export async function fetchInvoicesWithRelations(
  invoices: Invoice[],
): Promise<InvoiceWithRelations[]> {
  return loadInvoicesWithRelations(supabase, invoices);
}

/**
 * معرّفات وحدات العقار، وهي ما يُرشَّح به على الفواتير لا معرّفات الفواتير نفسها.
 *
 * A property's invoices are reached through `invoice_items.unit_id`, never
 * through `invoices.unit_id`: the latter is NULL for a consolidated multi-unit
 * invoice (migration 112) and `in` never matches NULL, so filtering on it
 * silently dropped every consolidated invoice.
 *
 * What is returned is the *unit* ids, because the filter now travels to the
 * server as an embedded condition. Materialising the invoice ids instead —
 * which is what this did until now — broke twice over on real data: the
 * `invoice_items` lookup was unranged and capped at 1,000 rows, so the largest
 * property resolved 897 of its 1,171 invoices, and those ids then exceeded
 * what one `in()` filter can carry in a URL. A property has at most a few dozen
 * units, so this list has no such ceiling.
 */
export async function fetchPropertyUnitIds(propertyId: string): Promise<string[]> {
  const { data, error } = await supabase.from("units").select("id").eq("property_id", propertyId);
  if (error) throw error;
  return data.map((unit) => unit.id);
}

/** الأعمدة المطلوبة عند الترشيح بعقار: ربط داخلي ببنود الفاتورة. */
const PROPERTY_FILTER_SELECT = "*, invoice_items!inner(unit_id)";

/**
 * يزيل بنود الفاتورة المضمّنة التي أُضيفت للترشيح فقط.
 *
 * `PROPERTY_FILTER_SELECT` nests an `invoice_items` array on every row purely
 * so PostgREST can filter on it. Leaving it attached would hand consumers a
 * unit list that is filtered to one property and therefore wrong for any other
 * purpose — the units an invoice really covers come from `unitIdsByInvoice`.
 */
export function stripEmbeddedItems<T>(row: T): T {
  if (row && typeof row === "object" && "invoice_items" in row) {
    const { invoice_items: _filterOnly, ...rest } = row as T & { invoice_items: unknown };
    return rest as T;
  }
  return row;
}

export function useInvoices(params: InvoiceListParams = {}, enabled = true) {
  const {
    contractId,
    disputed,
    fetchAll = false,
    overdue,
    page = 1,
    pageSize = 10,
    periodMonth,
    periodYear,
    propertyId,
    search = "",
    sortAsc = false,
    sortField = "created_at",
    state,
    tenantId,
    unitId,
  } = params;
  return useQuery({
    queryKey: [
      "invoices",
      {
        contractId,
        disputed,
        fetchAll,
        overdue,
        page,
        pageSize,
        periodMonth,
        periodYear,
        propertyId,
        search,
        sortAsc,
        sortField,
        state,
        tenantId,
        unitId,
      },
    ],
    enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async () => {
      // Both of these cost a round trip and neither varies between pages, so
      // they are resolved once and reused by every page `fetchAll` requests.
      let propertyUnitIds: string[] | null = null;
      // Invoices carry a unit, not a property — the complex hangs off the unit.
      // Resolved through invoice_items, never through invoices.unit_id: see
      // fetchPropertyUnitIds.
      if (propertyId) {
        propertyUnitIds = await fetchPropertyUnitIds(propertyId);
        // A property with no units can hold no invoices. An empty set must mean
        // an empty list — falling through to an unfiltered query would answer a
        // different question than the one the operator asked.
        if (!propertyUnitIds.length) return { items: [] as InvoiceWithRelations[], count: 0 };
      }
      let searchClause = "";
      const term = normalizePostgrestSearch(search);
      if (term) {
        const { data: tenants, error: tenantError } = await supabase
          .from("tenants")
          .select("id")
          .or(`code.ilike.%${term}%,name.ilike.%${term}%`)
          .limit(100);
        if (tenantError) throw tenantError;
        const tenantClause = tenants.length
          ? `,tenant_id.in.(${tenants.map((tenant) => tenant.id).join(",")})`
          : "";
        searchClause = `code.ilike.%${term}%${tenantClause}`;
      }

      /**
       * يجلب صفحة واحدة من الفواتير ضمن المدى المطلوب.
       */
      const fetchPage = async (rangeFrom: number, rangeTo: number) => {
        let query = supabase
          .from("invoices")
          // The property filter rides along as an embedded condition rather
          // than a list of invoice ids, so paging, ordering and the exact count
          // all stay on the server. `!inner` drops invoices with no matching
          // line item; it does not repeat the ones that match several.
          //
          // Cast because `database.types.ts` is hand-maintained and carries no
          // relationship metadata for invoice_items, so supabase-js cannot type
          // the embed. `"*"` is the shape callers actually receive: the embedded
          // array is stripped below before anything downstream sees it.
          .select((propertyUnitIds ? PROPERTY_FILTER_SELECT : "*") as "*", { count: "exact" })
          .order(sortField, { ascending: sortAsc });
        // Invoices bulk-generated for a tenant share an identical created_at, so a
        // single-column sort is non-deterministic (Postgres returns heap order).
        // The zero-padded, fixed-width `code` is a stable numeric tiebreaker that
        // keeps pagination consistent and surfaces the genuinely latest invoice.
        if (sortField !== "code") {
          query = query.order("code", { ascending: sortAsc });
        }
        query = query.range(rangeFrom, rangeTo);
        if (periodYear) query = query.eq("period_year", periodYear);
        if (periodMonth) query = query.eq("period_month", periodMonth);
        if (contractId) query = query.eq("contract_id", contractId);
        if (tenantId) query = query.eq("tenant_id", tenantId);
        if (unitId) query = query.eq("unit_id", unitId);
        if (state) query = query.eq("state", state);
        if (overdue) query = query.eq("state", "overdue");
        // Opt-in dispute filter only — never hide archived-contract invoices by default.
        if (disputed === true) query = query.not("disputed_at", "is", null);
        if (disputed === false) query = query.is("disputed_at", null);
        if (propertyUnitIds) query = query.in("invoice_items.unit_id", propertyUnitIds);
        if (searchClause) query = query.or(searchClause);
        const { data, error, count } = await query;
        if (error) throw error;
        // The embedded rows exist only to filter; every consumer downstream
        // expects a plain invoice row and resolves units through its own query.
        return { rows: data.map(stripEmbeddedItems), count: count ?? 0 };
      };

      const { rows, count } = fetchAll
        ? await fetchAllOffsetPages(fetchPage)
        : await fetchPage((page - 1) * pageSize, (page - 1) * pageSize + pageSize - 1);
      return { items: await fetchInvoicesWithRelations(rows), count };
    },
  });
}

/** صفّ شهر واحد من ملخّص السنة كما تعرضه بطاقات صفحة الفواتير. */
export interface MonthSummaryItem {
  month: number;
  count: number;
  total: number;
  paid: number;
  outstanding: number;
  overdue: number;
}

/**
 * استعلام ملخّص الشهور عبر RPC؛ الأرقام تعود نصّاً من PostgREST فتُحوَّل هنا.
 *
 * The aggregation moved into `get_invoice_month_summary` (migration 202) so a
 * building's pro-rated share of consolidated invoices can be computed beside
 * the data instead of in the browser; the numeric/bigint columns PostgREST
 * serialises as strings become numbers here, once, on the boundary.
 */
export function monthlyInvoiceSummaryQuery(year: number, propertyId: string | null) {
  return async (): Promise<MonthSummaryItem[]> => {
    const { data, error } = await supabase.rpc("get_invoice_month_summary", {
      p_year: year,
      p_property_id: propertyId,
    });
    if (error) throw error;
    return (data ?? []).map((row) => ({
      month: Number(row.month),
      count: Number(row.count),
      total: Number(row.total),
      paid: Number(row.paid),
      outstanding: Number(row.outstanding),
      overdue: Number(row.overdue),
    }));
  };
}

/**
 * ملخّص الشهور لسنة، اختيارياً لمبنى واحد؛ المفتاح يحمل المبنى فلا تُخدم نتيجة مبنى آخر.
 */
export function useMonthlyInvoiceSummary(year: number, propertyId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["invoice-month-summary", year, propertyId],
    enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: monthlyInvoiceSummaryQuery(year, propertyId),
  });
}

/**
 * Years selectable in the Monthly Invoices dropdown: every year that already
 * has invoices, unioned with the add-only `invoice_years` registry, plus the
 * current year. Sorted descending. Registry rows are never removed, so a year
 * added here stays forever.
 */
export function useInvoiceYears(enabled = true) {
  return useQuery({
    queryKey: ["invoice-years"],
    enabled,
    queryFn: async (): Promise<number[]> => {
      const [dataYears, registry] = await Promise.all([
        supabase.from("invoices").select("period_year"),
        supabase.from("invoice_years").select("year"),
      ]);
      if (dataYears.error) throw dataYears.error;
      if (registry.error) throw registry.error;
      const years = new Set<number>([new Date().getFullYear()]);
      for (const row of dataYears.data) years.add(row.period_year);
      for (const row of registry.data) years.add(row.year);
      return [...years].sort((a, b) => b - a);
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useAddInvoiceYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (year: number) => {
      // Add-only: a duplicate primary key means the year already exists, which
      // is a no-op success rather than an error.
      const { error } = await supabase.from("invoice_years").insert({ year });
      if (error && error.code !== "23505") throw error;
      await logAuditForCurrentSession({
        action: "invoice_year.create",
        entityType: "invoice_year",
        entityId: String(year),
        after: { year },
      });
      return year;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice-years"] });
    },
  });
}

/**
 * Ids of every invoice with a line item attributed to this unit.
 *
 * `invoices.unit_id` is NULL for a consolidated multi-unit invoice (migration
 * 112), so a per-unit page cannot filter the invoice list by that column
 * alone — the tenant's rent would vanish from every unit tab on a
 * multi-unit contract. `invoice_items.unit_id` carries the per-line
 * attribution instead (rent lines are backfilled, migration 112) and never
 * goes NULL for a real line, so resolving through it covers both
 * single-unit and consolidated invoices.
 */
export function useUnitInvoiceIds(unitId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["unit-invoice-ids", unitId],
    enabled: Boolean(unitId) && enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async (): Promise<Set<string>> => {
      const { data, error } = await supabase
        .from("invoice_items")
        .select("invoice_id")
        .eq("unit_id", unitId!);
      if (error) throw error;
      return new Set(data.map((row) => row.invoice_id));
    },
  });
}

export function useInvoiceDetails(invoiceId: string | null) {
  return useQuery({
    queryKey: ["invoice-details", invoiceId],
    enabled: Boolean(invoiceId),
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async () => {
      const [itemResult, allocationResult] = await Promise.all([
        supabase.from("invoice_items").select("*").eq("invoice_id", invoiceId!).order("line"),
        supabase.from("payment_allocations").select("*").eq("invoice_id", invoiceId!),
      ]);
      if (itemResult.error) throw itemResult.error;
      if (allocationResult.error) throw allocationResult.error;
      const paymentIds = allocationResult.data.map((allocation) => allocation.payment_id);
      const [paymentResult, receiptResult] = paymentIds.length
        ? await Promise.all([
            supabase.from("payments").select("*").in("id", paymentIds),
            supabase.from("receipts").select("*").in("payment_id", paymentIds),
          ])
        : [
            { data: [] as Tables<"payments">[], error: null },
            { data: [] as Tables<"receipts">[], error: null },
          ];
      if (paymentResult.error) throw paymentResult.error;
      if (receiptResult.error) throw receiptResult.error;
      return {
        items: itemResult.data,
        allocations: allocationResult.data,
        payments: paymentResult.data,
        receipts: receiptResult.data,
      };
    },
  });
}

/**
 * فواتير عقد واحد التي يجوز ربطها بدفعة جزئية: مستحقة وبها رصيد.
 *
 * The dropdown must not offer paid/cancelled/waived rows — linking those would
 * either lock a complete note against a still-due invoice or describe a
 * settlement that already happened. `total` is selected with `balance` so the
 * dialog can show invoice total on create; a pinned paid row loads it separately.
 */
export function useSettleableInvoices(contractId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["invoices", "settleable", contractId],
    enabled: Boolean(contractId) && enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("id, code, period_year, period_month, state, balance, total")
        .eq("contract_id", contractId!)
        .in("state", ["due", "overdue", "partially_paid"])
        .gt("balance", 0)
        .order("period_year", { ascending: true })
        .order("period_month", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

/**
 * كل فواتير العقد لربط إيداع بنكي بها، مدفوعة كانت أو غير مدفوعة.
 *
 * Deliberately NOT `useSettleableInvoices`. That hook narrows to
 * due/overdue/partially_paid with a positive balance because a partial payment
 * can only refer to an outstanding invoice; widening it would change the
 * partial-payment dialog too. A deposit is recorded after the money reached the
 * bank, so the accountant may well have marked the invoice paid first and still
 * needs to find it here — the request asked for paid invoices to be listed.
 * The caller disables the ones that cannot be settled rather than hiding them.
 */
export function useContractInvoicesForDeposit(contractId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["invoices", "for-deposit", contractId],
    enabled: Boolean(contractId) && enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("id, code, period_year, period_month, state, balance, total")
        .eq("contract_id", contractId!)
        .order("period_year", { ascending: true })
        .order("period_month", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateInvoiceVisibility() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, visible }: { id: string; visible: boolean }) => {
      if (!permissions.can(PERMISSIONS.INVOICES_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("invoices")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: after, error } = await supabase
        .from("invoices")
        .update({ is_visible_to_tenant: visible })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "invoice.visibility.update",
        entityType: "invoice",
        entityId: id,
        before,
        after,
      });
      return after;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void invalidatePortalViews(queryClient);
      queryClient.invalidateQueries({ queryKey: ["invoice-month-summary"] });
    },
  });
}
