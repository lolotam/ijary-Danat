/**
 * حدود عرض الأرقام في التطبيق: الحساب يبقى بدقّته، والعرض يُقتطع إلى عدد صحيح.
 *
 * This module is the **display boundary** and nothing else. Every stored value,
 * every SQL computation, every amount posted to MyFatoorah and every CSV/XLSX
 * export keeps full 3-decimal (fils) precision — KWD is a 1000-fils currency
 * and truncating any of those would be a data-integrity bug, not a formatting
 * preference.
 *
 * What is truncated is the string a human reads. The product decision (2026-08)
 * is that displayed figures are whole numbers: `100.000 → 100`,
 * `100.500 → 100`, `25.999 → 25`. Truncation, never rounding — a displayed
 * figure must never exceed the amount actually charged.
 *
 * The known consequence, accepted when the rule was set: a residual balance of
 * `0.001` displays as `0`. An invoice's *state* badge (`due` / `paid`) is
 * computed from the exact balance, not from this string, and stays the source
 * of truth for whether something is settled.
 */

/** Currency shown alongside every amount. Kuwait is the only market. */
const CURRENCY_SUFFIX = "KWD";

/**
 * أصغر فارق يُعامَل كخطأ تمثيل عشري لا ككسر حقيقي، متناسباً مع حجم الرقم.
 *
 * A double can represent a stored `26.000` as `25.999999999999996`, and
 * truncating that naively reports 25 for an amount that is exactly 26. The
 * correction has to scale with magnitude: representation error is proportional
 * to the value, so a fixed `1e-9` is generous at `26` and *too small* at the
 * top of `numeric(14,3)` (~1e11), where one unit in the last place is already
 * around 1.5e-5.
 *
 * The floor keeps small values covered; the proportional term covers large
 * ones. Both stay far below one fils, which is the property that matters:
 * nudging by a whole rounding step would turn `25.9999` into `26` and make this
 * a rounding function, which is exactly what it must not be.
 */
function floatNoiseFor(value: number): number {
  return Math.max(1e-9, Math.abs(value) * Number.EPSILON * 4);
}

/**
 * يحوّل قيمة إلى عدد صحيح بقطع الكسر (نحو الصفر).
 *
 * Truncation is toward zero, so a negative amount (a refund, a credit) loses
 * its fraction the same way a positive one does: `-25.999 → -25`.
 *
 * The nudge before truncating only absorbs binary-representation error — a
 * genuine fraction, however small a fils it is, is still dropped.
 */
export function truncateAmount(value: number | string | null | undefined): number {
  const numeric = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  const nudged = numeric + Math.sign(numeric) * floatNoiseFor(numeric);
  const truncated = Math.trunc(nudged);
  // `Math.trunc(-0.5)` is `-0`, which `Intl` renders as "-0".
  return Object.is(truncated, -0) ? 0 : truncated;
}

/**
 * يبني منسّق أعداد صحيحة بالأرقام الإنجليزية (Western Arabic numerals).
 *
 * Always formats with Latin digits (en-KW) so displayed numbers remain
 * in English numerals across both Arabic and English locales.
 */
function integerFormatter(_locale?: string): Intl.NumberFormat {
  return new Intl.NumberFormat("en-KW", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/**
 * يعرض مبلغاً بلا رمز العملة — للأعمدة التي يحمل رأسها العملة.
 */
export function formatAmount(value: number | string | null | undefined, locale: string): string {
  return integerFormatter(locale).format(truncateAmount(value));
}

/**
 * يعرض مبلغاً متبوعاً برمز العملة.
 *
 * `currency` exists because `payments.currency`, `deposits.currency` and
 * `electricity_charges.currency` are real, editable columns with no `KWD`
 * check constraint — the MyFatoorah webhook copies the payment request's
 * currency straight through. Call sites that hold a record's own currency must
 * pass it; printing "KWD" beside an amount that is not KWD is worse than any
 * formatting inconsistency.
 */
export function formatKwd(
  value: number | string | null | undefined,
  locale: string,
  currency: string | null | undefined = CURRENCY_SUFFIX,
): string {
  return `${formatAmount(value, locale)} ${currency?.trim() || CURRENCY_SUFFIX}`;
}

/**
 * يعرض نسبة مئوية كعدد صحيح متبوعاً بعلامة النسبة.
 *
 * A discount stored as `10.00` reads as `10%`. Percentages follow the same
 * whole-number rule as money so a single row does not mix `10%` with `7.500`.
 */
export function formatPercent(value: number | string | null | undefined, locale: string): string {
  return `${integerFormatter(locale).format(truncateAmount(value))}%`;
}
