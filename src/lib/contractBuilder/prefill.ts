import type { ContractUnitDetail } from "@/hooks/useContractRelations";
import type { Tables } from "@/integrations/supabase/database.types";

import { normalizePhoneDigits } from "@/lib/kuwaitPhone";

import {
  CONTRACT_LIMITS,
  EMPTY_COMPANY,
  type ContractBuilderValues,
  type ContractLocale,
  type ContractPlot,
} from "./schema";
import { isRoofUnit, unitLabels } from "./units";

export type PrefillNotice =
  | "multi_property"
  | "increase_fixed_not_supported"
  | "units_truncated"
  | "roof_units_excluded";

/**
 * يختار رقم البطاقة من نفس الكيان الذي طُبع اسمه: المالك أو المدير المفوض.
 *
 * Pairing a manager's civil id with the company's name is how the printed
 * second-party block used to identify the wrong person.
 */
function signatoryFor(tenant: Tables<"tenants">): {
  full_name: string;
  civil_id: string;
  isManager: boolean;
} {
  const manager = tenant.authorized_manager?.trim();
  const ownerIsTenantName = tenant.owner_name?.trim() === tenant.name.trim();
  // Migration 149 retired `owner_name`, so a current tenant with a manager has
  // it null: the manager's civil id is the one on file, and the name printed
  // beside it must be the MANAGER's, never the company name in `tenant.name`.
  if (manager && !ownerIsTenantName) {
    return {
      full_name: manager,
      civil_id: tenant.authorized_manager_civil_id?.trim() ?? "",
      isManager: true,
    };
  }
  const owner = tenant.owner_name?.trim();
  return {
    full_name: owner || tenant.name,
    civil_id: tenant.owner_civil_id?.trim() ?? "",
    isManager: false,
  };
}

/**
 * يعبئ الطرف الثاني: شركة يمثلها مديرها المفوض، أو شخصاً واحداً.
 *
 * A manager signing for a tenant whose name is someone else's — a company —
 * is exactly the company form's "represented by the authorized signatory".
 * A manager whose name IS the tenant's is the person themselves.
 */
function secondPartyFor(
  tenant: Tables<"tenants">,
): Pick<ContractBuilderValues, "second_party_type" | "persons" | "company"> {
  const signatory = signatoryFor(tenant);
  const nationality = tenant.nationality?.trim() ?? "";
  const address = tenant.commercial_address?.trim() ?? "";
  if (signatory.isManager && signatory.full_name !== tenant.name.trim()) {
    return {
      second_party_type: "company",
      persons: [],
      company: {
        company_name: tenant.name.trim(),
        company_address: address,
        signatory_name: signatory.full_name,
        signatory_nationality: nationality,
        signatory_civil_id: signatory.civil_id,
        signatory_address: "",
      },
    };
  }
  return {
    second_party_type: "individual",
    persons: [
      {
        full_name: signatory.full_name,
        nationality,
        civil_id: signatory.civil_id,
        residence_address: address,
      },
    ],
    company: { ...EMPTY_COMPANY },
  };
}

/**
 * يحوّل رقماً مخزناً إلى صيغة E.164، ويترك ما لا يمكن تطبيعه كما هو ليصححه المشغّل.
 *
 * Tenants' numbers are stored as bare 8-digit Kuwaiti mobiles; the contact
 * field requires +965…, so without this every prefilled contract would fail
 * validation on a number that is perfectly good.
 */
function toE164(raw: string | null): string {
  const trimmed = raw?.trim() ?? "";
  const normalized = normalizePhoneDigits(trimmed);
  // `00` is the dialled international prefix, the same thing `+` writes; kept,
  // it would produce "+00965…", which E.164 rejects.
  return normalized.ok ? `+${normalized.digits.replace(/^00/, "")}` : trimmed;
}

/**
 * يختار الاسم التجاري بحسب لغة الوثيقة، مع الرجوع إلى الحقل غير المترجم.
 */
export function localizedTradeName(tenant: Tables<"tenants">, locale: ContractLocale): string {
  const localized = locale === "en" ? tenant.commercial_name_en : tenant.commercial_name_ar;
  return localized?.trim() || tenant.commercial_name?.trim() || "";
}

/**
 * يبني قيماً جزئية لنموذج عقد الاستثمار من عقد ومستأجر ووحدات موجودة.
 *
 * Only keys that have a value are returned so `reset({ ...defaults, ...values })`
 * keeps numeric defaults for everything the contract does not store.
 */
export function prefillFromContract(
  input: {
    contract: Tables<"contracts">;
    tenant: Tables<"tenants">;
    units: ContractUnitDetail[];
  },
  locale: ContractLocale,
): { values: Partial<ContractBuilderValues>; notices: PrefillNotice[] } {
  const { contract, tenant, units } = input;
  const notices: PrefillNotice[] = [];
  const values: Partial<ContractBuilderValues> = { language: locale };

  Object.assign(values, secondPartyFor(tenant));
  values.contact_mobile = toE164(tenant.mobile);
  values.contact_whatsapp = toE164(tenant.whatsapp);
  values.contact_email = tenant.email?.trim() ?? "";

  // Roof units are never part of an investment contract; one linked to this
  // contract is dropped with a notice rather than silently, because the
  // monthly value below still covers it.
  const printable = units.filter((row) => !isRoofUnit(row.unit));
  if (printable.length < units.length) notices.push("roof_units_excluded");

  const plots = new Map<string, ContractPlot>();
  for (const row of printable) {
    const id = row.property?.id ?? row.unit.property_id;
    if (!id || plots.has(id)) continue;
    plots.set(id, {
      id,
      name_ar: row.property?.name_ar?.trim() ?? "",
      name_en: row.property?.name_en?.trim() ?? "",
    });
  }
  if (plots.size > 0) values.plots = [...plots.values()];
  if (plots.size > 1) {
    notices.push("multi_property");
  } else {
    const address = printable[0]?.property?.address_ar?.trim();
    if (address) values.governorate = address;
  }

  // The document holds six unit lines; a longer contract must be told, not
  // silently shortened, because the monthly value below covers ALL its units.
  if (printable.length > CONTRACT_LIMITS.units) notices.push("units_truncated");
  const unitLines = printable.slice(0, CONTRACT_LIMITS.units).map((row) => ({
    unit_id: row.unit.id,
    property_id: row.property?.id ?? row.unit.property_id,
    ...unitLabels(row.unit),
    paci_no: row.unit.paci_no?.trim() ?? "",
  }));
  if (unitLines.length > 0) values.units = unitLines;

  if (contract.commercial_activity?.trim()) values.activity = contract.commercial_activity.trim();
  const trade = localizedTradeName(tenant, locale);
  if (trade) values.trade_name = trade;

  if (contract.duration_months != null) values.duration_months = contract.duration_months;
  if (Number.isFinite(contract.monthly_amount))
    values.monthly_value = Number(contract.monthly_amount);
  if (contract.start_date) values.contract_date = contract.start_date;

  if (contract.increase_type === "fixed") {
    notices.push("increase_fixed_not_supported");
  } else if (
    contract.increase_type === "percent" &&
    contract.increase_after_years != null &&
    contract.increase_value != null
  ) {
    values.increase = {
      every_years: contract.increase_after_years,
      percent: Number(contract.increase_value),
    };
  }

  return { values, notices };
}
