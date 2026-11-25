import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays } from "date-fns";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import type { Locale } from "@/i18n/dictionary";
import { supabase } from "@/integrations/supabase/client";
import { fetchInChunks } from "@/lib/idChunks";
import { fetchAllPages, keysetAfter, type KeysetKey, type RangeQuery } from "@/lib/pagedQuery";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

export type ReportType =
  | "tenant_report"
  | "payment_report"
  | "expenses"
  | "deposits"
  | "overdue_aging"
  | "property_status"
  | "tenant_status";

export interface ReportPreviewRow {
  [key: string]: number | string;
}

export interface ReportPreviewParams {
  from: string;
  search: string;
  to: string;
  type: ReportType;
  /**
   * لغة الواجهة، لأن اسم المستأجر يُعرض بها.
   *
   * Part of the params object rather than read from a provider inside the hook
   * so it lands in the React Query key for free — a locale outside the key
   * serves the previously cached Arabic rows after the user switches to
   * English. `fetchReportExport` shares this shape for the same reason: the
   * CSV must not contradict the screen it was exported from.
   */
  locale: Locale;
}

export interface ReportPreviewResult {
  rows: ReportPreviewRow[];
  /** Total matching rows before the preview cap. */
  total: number;
  /** True when more rows exist than were returned for the preview. */
  truncated: boolean;
  previewLimit: number;
}

/** Hard cap for the on-screen report preview. Export uses {@link fetchReportRows}. */
export const REPORT_PREVIEW_LIMIT = 100;

type FetchMode = "preview" | "export";

interface QueryRows<Row> {
  rows: Row[];
  total: number;
}

/**
 * مفاتيح ترتيب تقرير: عمود تاريخ أو اسم، ثم `id` كفاصل فريد.
 *
 * Shared shape so every report declares its order once and the same keys
 * drive both `.order()` and the export cursor; a builder that ordered by one
 * thing and paged by another would skip rows.
 */
function keys<Row extends { id: string }>(
  column: string,
  ascending: boolean,
  value: (row: Row) => string | number,
): KeysetKey<Row>[] {
  return [
    { column, ascending, value },
    { column: "id", ascending, value: (row) => row.id },
  ];
}

/**
 * ينفّذ استعلام التقرير بحسب الوضع: صفحة واحدة محدودة للمعاينة، أو كل الصفحات
 * للتصدير بمفتاح ترتيب.
 *
 * Export used to drop `.range()` and trust the server to return everything;
 * PostgREST answers an unranged request with its first thousand rows and no
 * error, so any report past that exported a silently shortened CSV. The
 * builder receives the cursor row and applies `keysetAfter` itself, because
 * only it knows the query; `keys` is what it ordered by.
 */
async function runReportQuery<Row>(
  build: (after: Row | null) => RangeQuery<Row>,
  mode: FetchMode,
): Promise<QueryRows<Row>> {
  if (mode === "export") {
    const { rows, count } = await fetchAllPages(build);
    return { rows, total: count };
  }
  const result = await build(null).range(0, REPORT_PREVIEW_LIMIT - 1);
  if (result.error) throw result.error;
  const rows = result.data ?? [];
  return { rows, total: result.count ?? rows.length };
}

/** يغلّف الصفوف بحقول النتيجة الموحّدة؛ `truncated` لا معنى له إلا في المعاينة. */
function toResult(rows: ReportPreviewRow[], total: number, mode: FetchMode): ReportPreviewResult {
  return {
    rows,
    total,
    truncated: mode === "preview" && total > rows.length,
    previewLimit: REPORT_PREVIEW_LIMIT,
  };
}

interface TenantName {
  id: string;
  code: string;
  name: string;
  name_en: string | null;
}

/**
 * يجلب أسماء المستأجرين بمعرّفاتهم على دفعات، لأن تصديراً بآلاف الصفوف يحمل
 * آلاف المعرّفات — أكثر مما يحتمله عنوان URL واحد أو ردّ واحد من PostgREST.
 */
async function lookupTenants(ids: readonly string[]): Promise<Map<string, TenantName>> {
  const rows = await fetchInChunks(ids, (chunk) =>
    supabase.from("tenants").select("id,code,name,name_en").in("id", chunk),
  );
  return new Map(rows.map((item) => [item.id, item]));
}

async function fetchReportRows(
  params: ReportPreviewParams,
  mode: FetchMode,
): Promise<ReportPreviewResult> {
  const term = normalizePostgrestSearch(params.search);

  if (params.type === "expenses") {
    type Row = { id: string; expense_date: string };
    const order = keys<Row>("expense_date", false, (row) => row.expense_date);
    const { rows: data, total } = await runReportQuery((after: Row | null) => {
      let query = supabase
        .from("expenses")
        .select("id,code,payee,category_id,class,amount,currency,expense_date,status,recurrence", {
          count: "exact",
        })
        .gte("expense_date", params.from)
        .lte("expense_date", params.to)
        .order("expense_date", { ascending: false })
        .order("id", { ascending: false });
      if (term) query = query.or(`code.ilike.%${term}%,payee.ilike.%${term}%`);
      if (after) query = query.or(keysetAfter(order, after));
      return query;
    }, mode);
    const categoryIds = [
      ...new Set(data.flatMap((item) => (item.category_id ? [item.category_id] : []))),
    ];
    const categories = await fetchInChunks(categoryIds, (chunk) =>
      supabase.from("expense_categories").select("id,name_ar,name_en").in("id", chunk),
    );
    const names = new Map(categories.map((item) => [item.id, item.name_en ?? item.name_ar]));
    const rows = data.map((item) => ({
      code: item.code,
      payee: item.payee ?? "—",
      category: item.category_id ? (names.get(item.category_id) ?? "—") : "—",
      class: item.class,
      amount: item.amount,
      currency: item.currency,
      expense_date: item.expense_date,
      status: item.status,
      recurrence: item.recurrence ?? "—",
    }));
    return toResult(rows, total, mode);
  }

  if (params.type === "deposits") {
    type Row = { id: string; deposit_date: string };
    const order = keys<Row>("deposit_date", false, (row) => row.deposit_date);
    const { rows: data, total } = await runReportQuery((after: Row | null) => {
      let query = supabase
        .from("deposits")
        .select("id,code,deposit_date,bank_name,amount,currency,status,note", { count: "exact" })
        .gte("deposit_date", params.from)
        .lte("deposit_date", params.to)
        .order("deposit_date", { ascending: false })
        .order("id", { ascending: false });
      if (term)
        query = query.or(`code.ilike.%${term}%,bank_name.ilike.%${term}%,note.ilike.%${term}%`);
      if (after) query = query.or(keysetAfter(order, after));
      return query;
    }, mode);
    const rows = data.map((item) => ({
      code: item.code,
      deposit_date: item.deposit_date,
      bank_name: item.bank_name,
      amount: item.amount,
      currency: item.currency,
      status: item.status,
      note: item.note ?? "—",
    }));
    return toResult(rows, total, mode);
  }

  if (params.type === "payment_report") {
    type Row = { id: string; payment_date: string };
    const order = keys<Row>("payment_date", false, (row) => row.payment_date);
    const { rows: data, total } = await runReportQuery((after: Row | null) => {
      let query = supabase
        .from("payments")
        .select("id,code,tenant_id,amount,currency,payment_date,method,status,reference", {
          count: "exact",
        })
        .gte("payment_date", params.from)
        .lte("payment_date", params.to)
        .order("payment_date", { ascending: false })
        .order("id", { ascending: false });
      if (term) query = query.or(`code.ilike.%${term}%,reference.ilike.%${term}%`);
      if (after) query = query.or(keysetAfter(order, after));
      return query;
    }, mode);
    const tenants = await lookupTenants([...new Set(data.map((item) => item.tenant_id))]);
    const rows = data.map((item) => {
      const tenant = tenants.get(item.tenant_id);
      return {
        code: item.code,
        tenant: tenant ? tenantDisplayName(tenant, params.locale) : "—",
        date: item.payment_date,
        amount: item.amount,
        currency: item.currency,
        method: item.method,
        status: item.status,
        reference: item.reference ?? "—",
      };
    });
    return toResult(rows, total, mode);
  }

  if (params.type === "overdue_aging") {
    // The tenant is embedded with `!inner` so the search runs on the server
    // against the tenant's own columns, and the preview stays one bounded
    // request. Filtering after the join in the browser meant every overdue
    // invoice was downloaded just to show a hundred.
    type Row = { id: string; due_date: string };
    const order = keys<Row>("due_date", true, (row) => row.due_date);
    const { rows: data, total } = await runReportQuery((after: Row | null) => {
      let query = supabase
        .from("invoices")
        .select("id,code,due_date,balance,state,tenant:tenants!inner(id,code,name,name_en)", {
          count: "exact",
        })
        .eq("state", "overdue")
        .gt("balance", 0)
        .lte("due_date", params.to)
        .order("due_date", { ascending: true })
        .order("id", { ascending: true });
      if (term)
        query = query.or(`code.ilike.%${term}%,name.ilike.%${term}%,name_en.ilike.%${term}%`, {
          // The embed is exposed as `tenant`; PostgREST addresses an embedded
          // filter by that alias, so `tenants.or=` would not resolve.
          referencedTable: "tenant",
        });
      if (after) query = query.or(keysetAfter(order, after));
      return query;
    }, mode);
    const rows = data.map((item) => {
      const days = Math.max(
        0,
        differenceInCalendarDays(new Date(params.to), new Date(item.due_date)),
      );
      const bucket = days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
      // The hand-maintained types declare no relationships, so the embed is untyped;
      // PostgREST resolves it through the single invoices -> tenants FK at runtime.
      const tenant = item.tenant as unknown as TenantName | null;
      return {
        invoice: item.code as string,
        tenant: tenant ? `${tenant.code} — ${tenantDisplayName(tenant, params.locale)}` : "—",
        due_date: item.due_date,
        days,
        bucket,
        balance: item.balance as number,
      };
    });
    return toResult(rows, total, mode);
  }

  if (params.type === "property_status") {
    type Row = { id: string; code: string };
    const order = keys<Row>("code", true, (row) => row.code);
    const { rows: data, total } = await runReportQuery((after: Row | null) => {
      let query = supabase
        .from("units")
        .select("id,code,name,type,status,default_rent,property_id,building_id", {
          count: "exact",
        })
        .order("code", { ascending: true })
        .order("id", { ascending: true });
      if (term) query = query.or(`code.ilike.%${term}%,name.ilike.%${term}%`);
      if (after) query = query.or(keysetAfter(order, after));
      return query;
    }, mode);
    const rows = data.map((item) => ({
      code: item.code,
      name: item.name,
      type: item.type,
      status: item.status,
      default_rent: item.default_rent ?? 0,
      property_id: item.property_id,
      building_id: item.building_id ?? "—",
    }));
    return toResult(rows, total, mode);
  }

  type Row = { id: string; name: string };
  const order = keys<Row>("name", true, (row) => row.name);
  const { rows: data, total } = await runReportQuery((after: Row | null) => {
    let query = supabase
      .from("tenants")
      .select(
        "id,code,name,name_en,lifecycle,category,email,mobile,whatsapp,reminders_enabled,created_at",
        { count: "exact" },
      )
      .lte("created_at", `${params.to}T23:59:59.999Z`)
      .order("name", { ascending: true })
      .order("id", { ascending: true });
    if (params.type === "tenant_report") {
      query = query.gte("created_at", `${params.from}T00:00:00.000Z`);
    }
    // `name_en` is in the filter because the column the operator can *see* is
    // the localised one: searching an English name against the Arabic column
    // alone returned nothing, which is the bug this report was reported for.
    if (term)
      query = query.or(
        `code.ilike.%${term}%,name.ilike.%${term}%,name_en.ilike.%${term}%,email.ilike.%${term}%`,
      );
    if (after) query = query.or(keysetAfter(order, after));
    return query;
  }, mode);
  const rows = data.map((item) => ({
    code: item.code,
    name: tenantDisplayName(item, params.locale),
    lifecycle: item.lifecycle,
    category: item.category,
    email: item.email ?? "—",
    mobile: item.mobile ?? "—",
    whatsapp: item.whatsapp ?? "—",
    reminders: item.reminders_enabled ? "yes" : "no",
  }));
  return toResult(rows, total, mode);
}

/**
 * Bounded on-screen preview. Never use this dataset as the sole export source
 * when `truncated` is true — call {@link fetchReportExport} instead.
 */
export function useReportPreview(params: ReportPreviewParams, enabled = true) {
  return useQuery({
    queryKey: ["report-preview", params, REPORT_PREVIEW_LIMIT],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: () => fetchReportRows(params, "preview"),
  });
}

/**
 * Full matching dataset for CSV export / intentional full downloads, paged past
 * the server's row cap by keyset. Not wired as a continuous React Query
 * subscription — invoke on export click.
 */
export async function fetchReportExport(params: ReportPreviewParams): Promise<ReportPreviewRow[]> {
  const result = await fetchReportRows(params, "export");
  return result.rows;
}
