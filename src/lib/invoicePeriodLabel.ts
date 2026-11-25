/**
 * أسماء الشهور بالإنجليزية لتسمية فترة الفاتورة.
 *
 * A fixed table rather than `Intl.DateTimeFormat`: the month name is shown in
 * English in *both* locales, so asking the runtime for a localised name would
 * either return Arabic under `ar` or depend on which locale data the browser
 * happens to ship.
 */
const MONTH_NAMES_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * يحوّل سنة وشهر الفاتورة إلى تسمية مقروءة مثل «January 2026».
 *
 * Deliberately English in the Arabic UI too: the accountant asked to read the
 * month as a word rather than a number, and a numeric month beside an invoice
 * code is exactly the ambiguity this removes.
 *
 * `invoices.period_month` is constrained to 1–12 in the database, so there is
 * no out-of-range branch to write.
 *
 * Lives here rather than beside its first caller because it now has two — the
 * partial-payment dialog and the deposit form — and a component file that also
 * exports a helper breaks Fast Refresh for the whole module.
 */
export function invoicePeriodLabel(periodYear: number, periodMonth: number): string {
  return `${MONTH_NAMES_EN[periodMonth - 1]} ${periodYear}`;
}
