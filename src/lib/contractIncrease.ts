import type { Locale } from "@/i18n/dictionary";

export type ContractIncreaseType = "percent" | "fixed";

/**
 * أول شهر تسري فيه الزيادة (YYYY-MM): بداية العقد + السنوات.
 *
 * Mirrors `contract_increase_effective_period` in migration 196 so the form
 * and the table show the same month the database prices from.
 */
export function contractIncreaseEffectivePeriod(startDate: string, afterYears: number): string {
  const [year, month] = startDate.split("-").map(Number);
  return `${year + afterYears}-${String(month).padStart(2, "0")}`;
}

/**
 * نص موجز للزيادة يُعرض في جدول العقود وملخّص النموذج.
 */
export function contractIncreaseLabel(
  locale: Locale,
  type: ContractIncreaseType,
  value: number,
  effective: string,
): string {
  const amount = type === "percent" ? `${value}%` : `${value} KWD`;
  return locale === "ar"
    ? `زيادة ${amount} من ${effective}`
    : `Increase ${amount} from ${effective}`;
}
