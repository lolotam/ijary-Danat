import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import {
  loadCompanyDefaults,
  loadTenantName,
  notifyAdminEvent,
  renderAdminEmailCopy,
  rowOrThrow,
  type AdminEmailMessage,
  type AdminNotificationResult,
} from "@/fns/adminEmailNotification";
import type { NotificationType, Tables } from "@/integrations/supabase/database.types";
import { joinLocalizedList } from "@/lib/contractUnits";
import type { EmailLocale } from "@/lib/emailTemplates";

export type ContractEvent = "created" | "ended";

/** نوع الإشعار المقابل لحدث العقد. */
function notificationType(event: ContractEvent): NotificationType {
  return event === "created" ? "contract_created" : "contract_ended";
}

/**
 * يجمع أسماء كل وحدات العقد في قائمة واحدة بلغة الرسالة.
 *
 * Every unit the contract holds (migration 110), not contracts.unit_id
 * (deprecated, no longer read) — the created/ended notice has to name all of
 * them, not just the first.
 */
async function loadUnitNames(contractId: string, locale: EmailLocale): Promise<string> {
  const db = companyClient(requireRequestCompany().id);
  const contractUnits = await db
    .from("contract_units")
    .select("unit_id")
    .eq("contract_id", contractId)
    .order("line_order");
  const unitIds = [...new Set((contractUnits.data ?? []).map((row) => row.unit_id))];
  if (!unitIds.length) return "-";
  const units = await db.from("units").select("name").in("id", unitIds);
  if (!units.data?.length) return "-";
  return joinLocalizedList(
    units.data.map((row) => row.name),
    locale,
  );
}

/**
 * يبني رمز قالب حدث العقد بلا لاحقة لغوية.
 *
 * After the locale collapse the row is bilingual; a locale suffix would miss it.
 */
function templateCode(event: ContractEvent): string {
  return `contract-${event}`;
}

/** العنوان الاحتياطي حين لا يوجد قالب مخزّن. */
function fallbackSubject(event: ContractEvent, locale: EmailLocale): string {
  if (locale === "ar") return event === "created" ? "عقد جديد" : "انتهاء عقد";
  return event === "created" ? "Contract created" : "Contract ended";
}

/** يبني رسالة إنشاء العقد أو انتهائه وحمولتها. */
async function buildContractMessage(
  contract: Tables<"contracts">,
  event: ContractEvent,
): Promise<AdminEmailMessage> {
  const [{ locale }, tenantName] = await Promise.all([
    loadCompanyDefaults(),
    loadTenantName(contract.tenant_id),
  ]);
  const copy = await renderAdminEmailCopy({
    code: templateCode(event),
    locale,
    variables: {
      tenant_name: tenantName,
      contract_code: contract.code,
      unit_name: await loadUnitNames(contract.id, locale),
      start_date: contract.start_date,
      end_date: contract.end_date,
    },
    fallbackSubject: fallbackSubject(event, locale),
    fallbackBody: (safe) =>
      `<p>${safe.contract_code} - ${safe.tenant_name}</p><p>${safe.unit_name} - ${safe.end_date}</p>`,
  });
  return { copy, payload: { contract_id: contract.id, event }, contractId: contract.id };
}

/** يرسل تنبيه حدث العقد إلى الإدارة عبر بوابة سير العمل الخاصة بالحدث. */
function notifyContractEvent(
  contractId: string,
  event: ContractEvent,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(`contract-${event}`, {
    type: notificationType(event),
    load: async () =>
      rowOrThrow(
        await companyClient(requireRequestCompany().id)
          .from("contracts")
          .select("*")
          .eq("id", contractId)
          .single(),
      ),
    dedupeMatch: { contract_id: contractId, event },
    build: (contract) => buildContractMessage(contract, event),
  });
}

/** يرسل تنبيه إنشاء عقد جديد إلى الإدارة. */
export async function notifyContractCreatedRecord(
  contractId: string,
): Promise<AdminNotificationResult> {
  return notifyContractEvent(contractId, "created");
}

/** يرسل تنبيه انتهاء عقد إلى الإدارة. */
export async function notifyContractEndedRecord(
  contractId: string,
): Promise<AdminNotificationResult> {
  return notifyContractEvent(contractId, "ended");
}
