/**
 * مُحلّلات متغيرات القوالب حسب نوع الإشعار (متأخرات، تذكير استحقاق، إيصال، انتهاء عقد).
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { LocaleCode, NotificationType } from "@/integrations/supabase/database.types";
import { joinLocalizedList } from "@/lib/contractUnits";
import { portalInvoicesUrl } from "@/lib/emailTemplates";
import { TEMPLATE_VARIABLES } from "@/lib/templateVariables";
import { formatKwd } from "@/lib/money";

function daysBetween(dueDate: string, asOf: string): number {
  return Math.max(
    0,
    Math.floor((new Date(asOf).getTime() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24)),
  );
}

/**
 * يحسب الأيام المتبقية حتى تاريخ انتهاء العقد (سقف عند الصفر).
 */
function daysUntilEnd(endDate: string, asOf: string): number {
  return Math.max(
    0,
    Math.floor((new Date(endDate).getTime() - new Date(asOf).getTime()) / (1000 * 60 * 60 * 24)),
  );
}

/**
 * يحمّل رموز وأسماء الوحدات لعقود معيّنة ويضمّها بفاصل محلي.
 */
async function unitLabelForContracts(contractIds: string[], locale: LocaleCode): Promise<string> {
  if (!contractIds.length) return "";
  const cu = await supabaseAdmin
    .from("contract_units")
    .select("contract_id, unit_id")
    .in("contract_id", contractIds)
    .order("line_order");
  if (cu.error) throw new Error(cu.error.message);
  const unitIds = [...new Set((cu.data ?? []).map((row) => row.unit_id))];
  if (!unitIds.length) return "";
  const units = await supabaseAdmin.from("units").select("id, code, name").in("id", unitIds);
  if (units.error) throw new Error(units.error.message);
  const labels = (units.data ?? []).map((unit) => `${unit.code} — ${unit.name}`);
  return labels.length ? joinLocalizedList(labels, locale) : "—";
}

/**
 * يستبعد العقود المؤرشفة من مجموعة معرفات — القاعدة العامة في المنصة (migration 82).
 */
async function liveContractIds(contractIds: string[]): Promise<Set<string>> {
  if (!contractIds.length) return new Set();
  const result = await supabaseAdmin
    .from("contracts")
    .select("id")
    .in("id", contractIds)
    .is("archived_at", null);
  if (result.error) throw new Error(result.error.message);
  return new Set((result.data ?? []).map((row) => row.id));
}

/**
 * يحمّل صف القالب النشط بالرمز فقط — اللغة تُقرأ من أعمدة المحتوى.
 *
 * After the locale collapse a single row holds both languages. A type+locale or
 * -ar/-en swap would pick the wrong row, or hide an admin-created
 * `lease-renewal-ar`.
 */

export async function resolveOverdueVariables(
  tenantId: string,
  locale: LocaleCode,
  contractId: string | null | undefined,
  asOf: string,
): Promise<Record<string, string>> {
  let query = supabaseAdmin
    .from("invoices")
    .select("id, tenant_id, contract_id, balance, due_date, state, is_visible_to_tenant")
    .eq("tenant_id", tenantId)
    .eq("state", "overdue")
    .gt("balance", 0)
    .eq("is_visible_to_tenant", true);
  if (contractId) query = query.eq("contract_id", contractId);
  const invoices = await query;
  if (invoices.error) throw new Error(invoices.error.message);

  const rows = invoices.data ?? [];
  const live = await liveContractIds([
    ...new Set(rows.map((row) => row.contract_id).filter(Boolean)),
  ]);
  const billable = rows.filter((row) => live.has(row.contract_id));
  if (!billable.length) {
    return {
      outstanding: "",
      days_overdue: "",
      pay_now_url: portalInvoicesUrl(),
    };
  }

  let balance = 0;
  let oldestDue = billable[0].due_date;
  for (const invoice of billable) {
    balance += Number(invoice.balance);
    if (invoice.due_date < oldestDue) oldestDue = invoice.due_date;
  }

  return {
    outstanding: formatKwd(balance, locale),
    days_overdue: String(daysBetween(oldestDue, asOf)),
    pay_now_url: portalInvoicesUrl(),
  };
}

/**
 * يحلّ متغيّرات due_reminder: tenant_name, amount, due_date (الكتالوج).
 */
export async function resolveDueReminderVariables(
  tenantId: string,
  locale: LocaleCode,
  contractId: string | null | undefined,
): Promise<Record<string, string>> {
  let query = supabaseAdmin
    .from("invoices")
    .select("id, contract_id, balance, due_date, state, is_visible_to_tenant")
    .eq("tenant_id", tenantId)
    .in("state", ["due", "partially_paid"])
    .gt("balance", 0)
    .eq("is_visible_to_tenant", true)
    .order("due_date", { ascending: true })
    .limit(20);
  if (contractId) query = query.eq("contract_id", contractId);
  const invoices = await query;
  if (invoices.error) throw new Error(invoices.error.message);

  const rows = invoices.data ?? [];
  const live = await liveContractIds([
    ...new Set(rows.map((row) => row.contract_id).filter(Boolean)),
  ]);
  const invoice = rows.find((row) => live.has(row.contract_id));
  if (!invoice) {
    return { amount: "", due_date: "" };
  }
  return {
    amount: formatKwd(Number(invoice.balance), locale),
    due_date: invoice.due_date,
  };
}

/**
 * يحلّ متغيّرات receipt: tenant_name, amount, payment_date, reference.
 */
export async function resolveReceiptVariables(
  tenantId: string,
  locale: LocaleCode,
  contractId: string | null | undefined,
): Promise<Record<string, string>> {
  const payments = await supabaseAdmin
    .from("payments")
    .select("id, amount, currency, status, payment_date, created_at, reference, code")
    .eq("tenant_id", tenantId)
    .eq("status", "confirmed")
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10);
  if (payments.error) throw new Error(payments.error.message);

  let payment = (payments.data ?? [])[0] ?? null;
  if (contractId && payments.data?.length) {
    // Prefer a payment that allocated to the pinned contract.
    for (const candidate of payments.data) {
      const allocations = await supabaseAdmin
        .from("payment_allocations")
        .select("invoice_id")
        .eq("payment_id", candidate.id);
      if (allocations.error) throw new Error(allocations.error.message);
      const invoiceIds = (allocations.data ?? []).map((row) => row.invoice_id);
      if (!invoiceIds.length) continue;
      const inv = await supabaseAdmin
        .from("invoices")
        .select("id, contract_id")
        .in("id", invoiceIds);
      if (inv.error) throw new Error(inv.error.message);
      if ((inv.data ?? []).some((row) => row.contract_id === contractId)) {
        payment = candidate;
        break;
      }
    }
  }

  if (!payment) {
    return { amount: "", payment_date: "", reference: "" };
  }
  return {
    amount: formatKwd(Number(payment.amount), locale, payment.currency),
    payment_date: payment.payment_date,
    reference: (payment.reference ?? payment.code ?? "").trim(),
  };
}

/**
 * يحلّ متغيّرات contract_expiry كما يرسلها contractExpiryJob.
 *
 * Catalogue: tenant_name, contract_code, end_date, unit, days_until, company_name.
 */
export async function resolveContractExpiryVariables(
  tenantId: string,
  locale: LocaleCode,
  contractId: string | null | undefined,
  asOf: string,
): Promise<Record<string, string>> {
  let query = supabaseAdmin
    .from("contracts")
    .select("id, code, end_date, state, start_date")
    .eq("tenant_id", tenantId)
    .is("archived_at", null)
    .order("start_date", { ascending: false })
    .limit(20);
  if (contractId) {
    query = supabaseAdmin
      .from("contracts")
      .select("id, code, end_date, state, start_date")
      .eq("id", contractId)
      .eq("tenant_id", tenantId)
      .is("archived_at", null)
      .limit(1);
  }
  const contracts = await query;
  if (contracts.error) throw new Error(contracts.error.message);
  const contract =
    (contracts.data ?? []).find((row) => row.state === "active") ?? (contracts.data ?? [])[0];
  if (!contract) {
    return {
      unit: "",
      end_date: "",
      days_until: "",
      contract_code: "",
    };
  }
  const unit = await unitLabelForContracts([contract.id], locale);
  const endDate = contract.end_date ?? "";
  return {
    unit,
    end_date: endDate,
    days_until: endDate ? String(daysUntilEnd(endDate, asOf)) : "",
    contract_code: contract.code,
  };
}

/**
 * يملأ القيم الحية حسب نوع القالب — مفاتيح TEMPLATE_VARIABLES فقط (+ pay_now_url للمتأخرات).
 */
export async function resolveTypeVariables(
  type: NotificationType | null | undefined,
  tenantId: string,
  locale: LocaleCode,
  contractId: string | null | undefined,
  asOf: string,
): Promise<Record<string, string>> {
  if (!type) return {};
  // Only the four types a manual send commonly uses with live data. Other types
  // still get tenant_name / company_name from the base map; catalogue keys that
  // need event context stay empty and appear in missing[].
  if (type === "overdue_reminder") {
    return resolveOverdueVariables(tenantId, locale, contractId, asOf);
  }
  if (type === "due_reminder") {
    return resolveDueReminderVariables(tenantId, locale, contractId);
  }
  if (type === "receipt") {
    return resolveReceiptVariables(tenantId, locale, contractId);
  }
  if (type === "contract_expiry") {
    return resolveContractExpiryVariables(tenantId, locale, contractId, asOf);
  }
  return {};
}

/** أي عائلة مُحلّلات تستطيع تزويد كل مفتاح في وضع النص الحر. */
