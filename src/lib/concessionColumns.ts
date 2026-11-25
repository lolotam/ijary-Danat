import { formatKwd, formatPercent } from "@/lib/money";

export type ConcessionColumnRow = {
  contract_id: string;
  type: "free_months" | "percentage_discount" | "fixed_discount";
  start_date: string;
  end_date: string;
  discount_percent: number | null;
  discount_amount: number | null;
};

export type PercentDiscountColumn = { months: number; percent: number };
export type FixedDiscountColumn = { months: number; amount: number };

export type ContractConcessionColumns = {
  freeMonths: number;
  percentDiscount: PercentDiscountColumn | null;
  fixedDiscount: FixedDiscountColumn | null;
};

/**
 * يجمع الأشهر التقويمية التي يغطيها نطاق تاريخي في مجموعة مفاتيح سنة-شهر.
 *
 * Mid-month bounds still count the whole calendar month, matching
 * concessionMonthsByContract: a 15 Jan–10 Mar span is three months.
 */
export function calendarMonthsInRange(startDate: string, endDate: string): Set<string> {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const months = new Set<string>();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return months;
  const startIndex = start.getFullYear() * 12 + start.getMonth();
  const endIndex = end.getFullYear() * 12 + end.getMonth();
  for (let index = startIndex; index <= endIndex; index += 1) {
    months.add(`${Math.floor(index / 12)}-${index % 12}`);
  }
  return months;
}

/**
 * يبني أعمدة الخصم الثلاث لكل عقد: أشهر مجانية، نسبة، مبلغ ثابت.
 *
 * Empty discounts are `null`, never `{ months: 0 }`, so the table can use the
 * page's existing "no value" dash instead of a zero. Month counts are the
 * union of calendar months per type; the displayed value is the earliest
 * concession of that type (one contract almost always has one of each).
 */
export function concessionColumnsByContract(
  rows: ConcessionColumnRow[],
): Map<string, ContractConcessionColumns> {
  const byContract = new Map<
    string,
    {
      free: Set<string>;
      percentMonths: Set<string>;
      percent: number | null;
      percentStart: string | null;
      fixedMonths: Set<string>;
      amount: number | null;
      amountStart: string | null;
    }
  >();

  /**
   * يُرجع (أو ينشئ) مجمع الأعمدة لعقد واحد.
   */
  function bucket(contractId: string) {
    const existing = byContract.get(contractId);
    if (existing) return existing;
    const created = {
      free: new Set<string>(),
      percentMonths: new Set<string>(),
      percent: null as number | null,
      percentStart: null as string | null,
      fixedMonths: new Set<string>(),
      amount: null as number | null,
      amountStart: null as string | null,
    };
    byContract.set(contractId, created);
    return created;
  }

  for (const row of rows) {
    const months = calendarMonthsInRange(row.start_date, row.end_date);
    const current = bucket(row.contract_id);
    if (row.type === "free_months") {
      for (const key of months) current.free.add(key);
      continue;
    }
    if (row.type === "percentage_discount") {
      for (const key of months) current.percentMonths.add(key);
      if (
        row.discount_percent != null &&
        (current.percentStart == null || row.start_date < current.percentStart)
      ) {
        current.percent = row.discount_percent;
        current.percentStart = row.start_date;
      }
      continue;
    }
    for (const key of months) current.fixedMonths.add(key);
    if (
      row.discount_amount != null &&
      (current.amountStart == null || row.start_date < current.amountStart)
    ) {
      current.amount = row.discount_amount;
      current.amountStart = row.start_date;
    }
  }

  const result = new Map<string, ContractConcessionColumns>();
  for (const [id, current] of byContract) {
    result.set(id, {
      freeMonths: current.free.size,
      percentDiscount:
        current.percentMonths.size > 0 && current.percent != null
          ? { months: current.percentMonths.size, percent: current.percent }
          : null,
      fixedDiscount:
        current.fixedMonths.size > 0 && current.amount != null
          ? { months: current.fixedMonths.size, amount: current.amount }
          : null,
    });
  }
  return result;
}

/**
 * يعدّ الأشهر المجانية النشطة على عقد؛ يعيد null إن لم يكن هناك أي شهر.
 *
 * Null (not 0) is the empty treatment InfoField already renders as "—".
 */
export function countActiveFreeMonths(
  concessions: Array<{
    type: string;
    status?: string;
    start_date: string;
    end_date: string;
  }>,
): number | null {
  const months = new Set<string>();
  for (const row of concessions) {
    if (row.type !== "free_months") continue;
    if (row.status && row.status !== "active") continue;
    for (const key of calendarMonthsInRange(row.start_date, row.end_date)) {
      months.add(key);
    }
  }
  return months.size > 0 ? months.size : null;
}

/**
 * يصيغ خلية خصم النسبة: `3 — 30%`، أو null للخلية الفارغة.
 *
 * Takes a locale so the percentage goes through the same whole-number formatter
 * as every other figure on the page. Interpolating `value.percent` raw left
 * this cell showing `7.5%` while the identical discount read `7%` on the
 * tenancy detail page.
 */
export function formatPercentDiscountCell(
  value: PercentDiscountColumn | null,
  locale: string,
): string | null {
  if (!value) return null;
  return `${value.months} — ${formatPercent(value.percent, locale)}`;
}

/**
 * يصيغ خلية الخصم الثابت: `3 — 100.000 KWD`، أو null للخلية الفارغة.
 */
export function formatFixedDiscountCell(
  value: FixedDiscountColumn | null,
  locale: string,
): string | null {
  if (!value) return null;
  return `${value.months} — ${formatKwd(value.amount, locale)}`;
}

export type ConcessionValueRow = {
  type: ConcessionColumnRow["type"];
  free_months: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
};

/**
 * يصيغ قيمة إعفاء واحد: المبلغ الثابت أو النسبة أو عدد الأشهر المجانية.
 *
 * Row-level, unlike `formatFixedDiscountCell` and `formatPercentDiscountCell`,
 * which fold every concession of a type onto one contracts-table cell. The
 * portal lease page lists each concession on its own line, where that aggregate
 * shape means nothing — and where the value was never shown at all:
 * `free_months`, `discount_percent` and `discount_amount` were fetched and
 * discarded, so a tenant read "Fixed discount · Oct 2026 · Active" with no way
 * to tell what it was worth.
 *
 * `monthsLabel` is passed in already translated; this module stays free of the
 * i18n provider so it can be unit-tested against both locales.
 */
export function concessionValueText(
  concession: ConcessionValueRow,
  locale: string,
  monthsLabel: string,
): string | null {
  switch (concession.type) {
    case "free_months":
      return concession.free_months && concession.free_months > 0
        ? `${concession.free_months} ${monthsLabel}`
        : null;
    case "percentage_discount":
      return concession.discount_percent != null
        ? formatPercent(concession.discount_percent, locale)
        : null;
    case "fixed_discount":
      return concession.discount_amount != null
        ? formatKwd(concession.discount_amount, locale)
        : null;
  }
}
