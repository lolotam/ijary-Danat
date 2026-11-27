import type { SupabaseClient } from "@supabase/supabase-js";
import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type { Database, LocaleCode, Tables } from "@/integrations/supabase/database.types";
import type { BuildFinalMessageInput, FinalMessage } from "@/fns/resolveTemplateVariables";
import {
  escapeVariables,
  renderTemplate,
  stripMarkup,
  visibleTemplateSource,
} from "@/lib/templateRender";
import {
  resolveContractExpiryVariables,
  resolveDueReminderVariables,
  resolveOverdueVariables,
  resolveReceiptVariables,
  resolveTypeVariables,
} from "@/fns/templateTypeResolvers";

/*
 * بناء الرسالة النهائية على الخادم: قراءة المستأجر والقالب وحلّ المتغيّرات.
 *
 * Split from `resolveTemplateVariables.ts` so the browser bundle, which imports
 * the preview server function from there, never loads the company client or
 * the request-company context these reads need.
 */

const PLACEHOLDER_RE = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

/**
 * يجمع كل مفاتيح `{{placeholder}}` المميزة من نص القالب، بترتيب الظهور.
 *
 * Regex matches renderTemplate so a resolver that finds keys the renderer
 * does not substitute cannot report a false "missing" list.
 */
export function collectPlaceholders(source: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of source.matchAll(PLACEHOLDER_RE)) {
    const key = match[1];
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

/**
 * يعيد أسماء المتغيّرات الموجودة في القالب بلا قيمة محلولة (أو بقيمة فارغة).
 *
 * An empty string is missing: a blank amount is not a resolved amount, and
 * the admin preview must surface it before send. The scan runs over the
 * **visible** source — hidden sections are removed with the same semantics
 * `renderTemplate` uses — so a variable an authored body deliberately drops
 * behind an empty `{{#discount}}` is not reported, while an unresolved key
 * inside a shown section still is.
 */
export function findMissingPlaceholders(
  source: string,
  variables: Record<string, string>,
): string[] {
  return collectPlaceholders(visibleTemplateSource(source, variables)).filter(
    (key) => !variables[key],
  );
}

/**
 * يحسب فرق الأيام بين تاريخين ISO (asOf − due)، بحد أدنى صفر.
 */
async function loadTemplate(
  db: SupabaseClient<Database>,
  requestedCode: string | null | undefined,
): Promise<{
  template: Tables<"notification_templates"> | null;
  unavailableReason: string | null;
}> {
  if (!requestedCode) return { template: null, unavailableReason: null };

  const byCode = await db
    .from("notification_templates")
    .select("*")
    .eq("code", requestedCode)
    .maybeSingle();
  if (byCode.error) throw new Error(byCode.error.message);

  if (byCode.data?.is_active) {
    return { template: byCode.data, unavailableReason: null };
  }

  return {
    template: null,
    unavailableReason: `No active template for ${requestedCode}.`,
  };
}

/**
 * يحلّ متغيّرات overdue_reminder كما يرسلها overdueRemindersJob.
 *
 * Catalogue (templateVariables.ts): tenant_name, outstanding, days_overdue.
 * pay_now_url is filled by the automatic job and kept for parity when an admin
 * body binds it — findMissingPlaceholders still surfaces any other unknown key.
 */
const FREE_TEXT_SOURCES = {
  overdue: ["outstanding", "days_overdue", "pay_now_url"],
  due: ["invoice_amount", "due_date"],
  receipt: ["payment_amount", "payment_date", "reference"],
  expiry: ["contract_code", "end_date", "unit", "days_until"],
} as const;

/**
 * يحلّ متغيّرات النص الحر — فقط العائلات التي يطلبها النص فعلًا.
 */
export async function resolveFreeTextVariables(
  tenantId: string,
  locale: LocaleCode,
  contractId: string | null | undefined,
  asOf: string,
  requestedKeys: string[],
): Promise<Record<string, string>> {
  const wanted = new Set(requestedKeys);
  const needs = (family: keyof typeof FREE_TEXT_SOURCES) =>
    FREE_TEXT_SOURCES[family].some((key) => wanted.has(key));

  const [overdue, due, receipt, expiry] = await Promise.all([
    needs("overdue") ? resolveOverdueVariables(tenantId, locale, contractId, asOf) : null,
    needs("due") ? resolveDueReminderVariables(tenantId, locale, contractId) : null,
    needs("receipt") ? resolveReceiptVariables(tenantId, locale, contractId) : null,
    needs("expiry") ? resolveContractExpiryVariables(tenantId, locale, contractId, asOf) : null,
  ]);

  return {
    ...(overdue && {
      outstanding: overdue.outstanding,
      days_overdue: overdue.days_overdue,
      pay_now_url: overdue.pay_now_url,
    }),
    ...(due && { invoice_amount: due.amount, due_date: due.due_date }),
    ...(receipt && {
      payment_amount: receipt.amount,
      payment_date: receipt.payment_date,
      reference: receipt.reference,
    }),
    ...(expiry && {
      contract_code: expiry.contract_code,
      end_date: expiry.end_date,
      unit: expiry.unit,
      days_until: expiry.days_until,
    }),
  };
}

/**
 * يبني الرسالة النهائية التي ستُحفظ في صف الإشعار ضمن نطاق الشركة — مصدر واحد للمعاينة والإرسال.
 */
export async function buildFinalMessage(input: BuildFinalMessageInput): Promise<FinalMessage> {
  const companyId = requireRequestCompany().id;
  const db = companyClient(companyId);

  const tenantResult = await db.from("tenants").select("*").eq("id", input.tenantId).single();
  if (tenantResult.error) throw new Error(tenantResult.error.message);
  const tenant = tenantResult.data;

  const companyResult = await db
    .from("companies")
    .select("*")
    .eq("id", tenant.company_id ?? companyId)
    .single();
  if (companyResult.error) throw new Error(companyResult.error.message);

  const locale: LocaleCode = input.locale ?? tenant.preferred_language ?? "ar";
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);

  const { template, unavailableReason } = await loadTemplate(db, input.templateCode);

  if (input.templateCode && unavailableReason) {
    return {
      variables: {},
      subject: "",
      bodyHtml: "",
      bodyText: "",
      missing: [],
      templateCode: null,
      templateType: null,
      locale,
      unavailableReason,
    };
  }

  const companyName =
    locale === "ar" ? (companyResult.data?.name_ar ?? "") : (companyResult.data?.name_en ?? "");

  // Free-text overrides replace template columns the same way sendNotification used to.
  // Resolved before the variables because free text picks its resolvers from the
  // placeholders these actually contain.
  const subjectSource =
    input.subject ?? (locale === "ar" ? template?.subject_ar : template?.subject_en) ?? "";
  const bodySource = input.body ?? (locale === "ar" ? template?.body_ar : template?.body_en) ?? "";

  // A template selects its variable set by `type`. Free text has no template, so
  // it selects by what the message actually asks for.
  const typeVariables = template
    ? await resolveTypeVariables(template.type, tenant.id, locale, input.contractId, asOf)
    : await resolveFreeTextVariables(
        tenant.id,
        locale,
        input.contractId,
        asOf,
        collectPlaceholders(`${subjectSource} ${bodySource}`),
      );

  // Base + type-specific + explicit overrides. Overrides last so the admin wins.
  const variables: Record<string, string> = {
    tenant_name: tenant.name,
    company_name: companyName,
    ...typeVariables,
    ...input.variables,
  };

  // Subject: RAW (plain header). Body: HTML-escaped values. See loadTemplateCopy.
  const safe = escapeVariables(variables);
  const subject = renderTemplate(subjectSource, variables) ?? "";
  const bodyHtml = renderTemplate(bodySource, safe) ?? "";
  const bodyText = stripMarkup(bodyHtml);
  const missing = findMissingPlaceholders(`${subjectSource} ${bodySource}`, variables);

  // Catalogue keys that the type claims to supply but are empty also count as
  // missing when the template body actually references them — already covered
  // by findMissingPlaceholders on empty strings.

  return {
    variables,
    subject,
    bodyHtml,
    bodyText,
    missing,
    templateCode: template?.code ?? null,
    templateType: template?.type ?? null,
    locale,
    unavailableReason: null,
  };
}
