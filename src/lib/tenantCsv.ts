import type { CsvRow } from "@/lib/csv";
import { unitCsvNames } from "@/lib/unitDisplayName";

/** Unit shape the tenant export needs for connected_* columns. */
export interface TenantExportUnit {
  code: string;
  name: string;
  name_en?: string | null;
}

/** Property shape the tenant export needs for connected_* columns. */
export interface TenantExportProperty {
  code: string;
  name_ar: string;
  name_en: string | null;
}

/** One active contract location as the tenants list attaches it. */
export interface TenantExportLocation {
  contract: {
    code: string;
    state: string;
    start_date: string;
    end_date: string | null;
    /**
     * Trigger-maintained contract total (migration 110).
     * When absent the column is blank rather than inventing a total.
     */
    monthly_amount?: number | null;
  };
  units: TenantExportUnit[];
  properties: TenantExportProperty[];
}

/**
 * The slice of a tenant the CSV export needs.
 *
 * Narrower than `TenantWithActiveLocation` so pure tests stay free of full
 * table rows and logo fields the export never touches.
 */
export interface TenantExportItem {
  code: string;
  name: string;
  category: string;
  lifecycle: string;
  nationality: string | null;
  preferred_language: string;
  mobile: string | null;
  whatsapp: string | null;
  email: string | null;
  commercial_name: string | null;
  commercial_name_ar: string | null;
  commercial_name_en: string | null;
  authorized_manager: string | null;
  authorized_manager_civil_id: string | null;
  owner_civil_id: string | null;
  commercial_address: string | null;
  notes: string | null;
  tenant_portal_enabled: boolean;
  reminders_enabled: boolean;
  receipt_visible_to_tenant: boolean;
  activeContracts: TenantExportLocation[];
}

/**
 * يحوّل قيمة خلية CSV إلى نص؛ القيم الفارغة تصبح سلسلة فارغة.
 */
function csvText(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

/**
 * يضمّ قيم عمود متعدد داخل خلية CSV واحدة بفاصلة منقوطة.
 *
 * Same separator the old route-local join used, so existing operator habits
 * (and any downstream spreadsheets that already split on "; ") keep working.
 */
function joinCsv(values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join("; ");
}

/**
 * يبني أعمدة المستأجر المشتركة (تُكرَّر على كل صف عقد).
 */
function tenantColumns(tenant: TenantExportItem): CsvRow {
  return {
    code: csvText(tenant.code),
    name: csvText(tenant.name),
    // name_en is deliberately absent: the bulk-import schema and the
    // admin bulk upsert don't accept it yet, so exporting it would silently
    // drop the value on re-import.
    category: csvText(tenant.category),
    lifecycle: csvText(tenant.lifecycle),
    nationality: csvText(tenant.nationality),
    preferred_language: csvText(tenant.preferred_language),
    mobile: csvText(tenant.mobile),
    whatsapp: csvText(tenant.whatsapp),
    email: csvText(tenant.email),
    commercial_name: csvText(tenant.commercial_name),
    commercial_name_ar: csvText(tenant.commercial_name_ar),
    commercial_name_en: csvText(tenant.commercial_name_en),
    authorized_manager: csvText(tenant.authorized_manager),
    authorized_manager_civil_id: csvText(tenant.authorized_manager_civil_id),
    owner_civil_id: csvText(tenant.owner_civil_id),
    commercial_address: csvText(tenant.commercial_address),
    notes: csvText(tenant.notes),
    tenant_portal_enabled: csvText(tenant.tenant_portal_enabled),
    reminders_enabled: csvText(tenant.reminders_enabled),
    receipt_visible_to_tenant: csvText(tenant.receipt_visible_to_tenant),
  };
}

/**
 * يبني أعمدة العقد والوحدات المرتبطة بصف واحد (عقد واحد).
 *
 * When `location` is null the contract/connected columns stay blank — a tenant
 * with zero contracts still emits one row and never vanishes from the file.
 */
function contractScopedColumns(
  location: TenantExportLocation | null,
  contractIndex: number | null,
): CsvRow {
  if (!location) {
    return {
      contract_index: "",
      contract_code: "",
      contract_state: "",
      contract_start_date: "",
      contract_end_date: "",
      contract_monthly_amount: "",
      connected_property_code: "",
      connected_unit_code: "",
      connected_property_name_ar: "",
      connected_property_name_en: "",
      connected_unit_name_ar: "",
      connected_unit_name_en: "",
    };
  }
  return {
    contract_index: contractIndex == null ? "" : String(contractIndex),
    contract_code: csvText(location.contract.code),
    contract_state: csvText(location.contract.state),
    contract_start_date: csvText(location.contract.start_date),
    contract_end_date: csvText(location.contract.end_date),
    contract_monthly_amount: csvText(location.contract.monthly_amount),
    connected_property_code: joinCsv(location.properties.map((property) => property.code)),
    connected_unit_code: joinCsv(location.units.map((unit) => unit.code)),
    connected_property_name_ar: joinCsv(location.properties.map((property) => property.name_ar)),
    connected_property_name_en: joinCsv(location.properties.map((property) => property.name_en)),
    connected_unit_name_ar: joinCsv(location.units.map((unit) => unitCsvNames(unit).ar)),
    connected_unit_name_en: joinCsv(location.units.map((unit) => unitCsvNames(unit).en)),
  };
}

/**
 * يحوّل المستأجرين إلى صفوف CSV، صفٌّ لكل عقد.
 *
 * The old export semicolon-joined every contract into one cell, so a tenant
 * with three contracts had three start dates in one column and no way to tell
 * which unit belonged to which contract. One row per contract makes the file
 * readable and keeps each contract's properties and units together.
 */
export function tenantCsvRows(tenants: TenantExportItem[]): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const tenant of tenants) {
    const base = tenantColumns(tenant);
    if (!tenant.activeContracts.length) {
      rows.push({ ...base, ...contractScopedColumns(null, null) });
      continue;
    }
    tenant.activeContracts.forEach((location, index) => {
      rows.push({ ...base, ...contractScopedColumns(location, index + 1) });
    });
  }
  return rows;
}
