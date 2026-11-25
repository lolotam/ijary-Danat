import type { CsvRow } from "@/lib/csv";

/** One unit line on a contract, as the list query attaches it. */
export interface ContractExportUnit {
  monthlyAmount: number;
  unit: { code: string; name: string } | null;
  property: {
    code: string;
    name_ar: string;
    name_en: string | null;
  } | null;
}

/**
 * The slice of a contract the CSV export needs.
 *
 * Deliberately narrower than `ContractWithRelations` so pure tests do not need
 * full table rows, and so the export cannot silently depend on display-only
 * fields (brand logos, etc.).
 */
export interface ContractExportItem {
  code: string;
  type: string;
  state: string;
  start_date: string;
  end_date: string;
  entry_date: string | null;
  duration_months: number | null;
  monthly_amount: number;
  deposit: number;
  due_day: number;
  grace_days: number;
  concessionMonths: number;
  end_date_override_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  tenant: { code: string; name: string } | null;
  units: ContractExportUnit[];
}

/**
 * يحوّل قيمة خلية CSV إلى نص؛ القيم الفارغة تصبح سلسلة فارغة.
 *
 * Spreadsheet round-trips treat every cell as text. Keeping the conversion in
 * one place means booleans/numbers never leak a locale-specific `toString`.
 */
function csvText(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

/**
 * يبني صفاً واحداً لعقد مع وحدة اختيارية (أو أعمدة وحدة فارغة).
 *
 * Column order matches the pre-extraction export so operator spreadsheets and
 * the contracts import template (code, tenant_code, unit_code, …) keep the
 * same left-to-right layout. New unit-line fields sit next to the unit block.
 */
function contractRow(
  contract: ContractExportItem,
  link: ContractExportUnit | null,
  lineOrder: number | null,
): CsvRow {
  return {
    code: csvText(contract.code),
    tenant_code: csvText(contract.tenant?.code),
    tenant_name: csvText(contract.tenant?.name),
    unit_code: csvText(link?.unit?.code),
    unit_name: csvText(link?.unit?.name),
    property_code: csvText(link?.property?.code),
    property_name_ar: csvText(link?.property?.name_ar),
    property_name_en: csvText(link?.property?.name_en),
    unit_line_order: lineOrder == null ? "" : String(lineOrder),
    unit_monthly_amount: link == null ? "" : csvText(link.monthlyAmount),
    type: csvText(contract.type),
    state: csvText(contract.state),
    start_date: csvText(contract.start_date),
    end_date: csvText(contract.end_date),
    entry_date: csvText(contract.entry_date),
    duration_months: csvText(contract.duration_months),
    monthly_amount: csvText(contract.monthly_amount),
    deposit: csvText(contract.deposit),
    due_day: csvText(contract.due_day),
    grace_days: csvText(contract.grace_days),
    concession_months: csvText(contract.concessionMonths),
    end_date_override_reason: csvText(contract.end_date_override_reason),
    notes: csvText(contract.notes),
    created_at: csvText(contract.created_at),
    updated_at: csvText(contract.updated_at),
  };
}

/**
 * يحوّل العقود إلى صفوف CSV، صفٌّ لكل وحدة داخل العقد.
 *
 * The old export took `primaryUnit(contract)` and dropped every other unit, so
 * a three-shop contract exported one shop. One row per unit keeps the re-import
 * contract intact — the importer reads unit_code + tenant_code from a single
 * row — while stopping the silent data loss.
 */
export function contractCsvRows(contracts: ContractExportItem[]): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const contract of contracts) {
    if (!contract.units.length) {
      rows.push(contractRow(contract, null, null));
      continue;
    }
    contract.units.forEach((link, index) => {
      rows.push(contractRow(contract, link, index + 1));
    });
  }
  return rows;
}
