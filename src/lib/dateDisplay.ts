/**
 * App date display rules (forms + read-only fields):
 * - LTR (English): dd/mm/yyyy
 * - RTL (Arabic):  yyyy/mm/dd
 *
 * Storage / API values stay ISO `yyyy-MM-dd`.
 */

export type DateTextDir = "ltr" | "rtl";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LTR_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const RTL_DATE = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/;

function pad2(n: number | string) {
  return String(n).padStart(2, "0");
}

function isValidYmd(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(year, month - 1, day);
  return dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day;
}

/** ISO `yyyy-MM-dd` (or full ISO timestamp) → display string for dir. */
export function formatIsoDateForDisplay(
  value: string | null | undefined,
  dir: DateTextDir,
): string {
  if (!value) return "";
  const datePart = value.slice(0, 10);
  const match = ISO_DATE.exec(datePart);
  if (!match) return datePart;
  const [, y, m, d] = match;
  return dir === "rtl" ? `${y}/${m}/${d}` : `${d}/${m}/${y}`;
}

export function displayDatePlaceholder(dir: DateTextDir): string {
  return dir === "rtl" ? "yyyy/mm/dd" : "dd/mm/yyyy";
}

/**
 * Parse a user-typed display date (or ISO) into `yyyy-MM-dd`.
 * Returns null if incomplete/invalid.
 */
export function parseDisplayDateToIso(display: string, dir: DateTextDir): string | null {
  const raw = display.trim();
  if (!raw) return "";

  const asIso = ISO_DATE.exec(raw.slice(0, 10));
  if (asIso) {
    const y = Number(asIso[1]);
    const m = Number(asIso[2]);
    const d = Number(asIso[3]);
    if (!isValidYmd(y, m, d)) return null;
    return `${asIso[1]}-${asIso[2]}-${asIso[3]}`;
  }

  if (dir === "rtl") {
    const match = RTL_DATE.exec(raw);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (!isValidYmd(y, m, d)) return null;
    return `${match[1]}-${pad2(m)}-${pad2(d)}`;
  }

  const match = LTR_DATE.exec(raw);
  if (!match) return null;
  const d = Number(match[1]);
  const m = Number(match[2]);
  const y = Number(match[3]);
  if (!isValidYmd(y, m, d)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Parse calendar Date → ISO date (local calendar day). */
export function dateToIsoLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Billing period for invoices/payments: `4/2026 = April 2026`.
 * Month is 1–12. Locale controls the long month name only.
 */
export function formatBillingPeriod(
  month: number,
  year: number,
  locale: "ar" | "en" = "en",
): string {
  return `${month}/${year} = ${formatMonthYear(month, year, locale)}`;
}

/**
 * يكتب الشهر باسمه مع السنة: «سبتمبر 2026» أو "September 2026".
 *
 * Month is 1–12. Latin digits in Arabic (`nu-latn`) so the year matches every
 * other number on the printed documents.
 */
export function formatMonthYear(month: number, year: number, locale: "ar" | "en"): string {
  const monthName = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", {
    month: "long",
  }).format(new Date(year, month - 1, 1));
  return `${monthName} ${year}`;
}

/**
 * يكتب شهر تاريخ ISO ‏(yyyy-mm-dd) باسمه مع السنة.
 *
 * Read from the string rather than through `new Date(iso)`, which parses a
 * date-only value as UTC midnight and can land on the previous month west of
 * Greenwich.
 */
export function formatIsoMonthYear(iso: string, locale: "ar" | "en"): string {
  const [year, month] = iso.split("-").map(Number);
  return formatMonthYear(month, year, locale);
}

/**
 * Payment date + clock time in one field.
 *
 * `payment_date` is a date-only column; the time comes from `created_at` (when
 * the payment was recorded). Falls back to date-only when time is missing.
 */
export function formatPaymentDateTime(
  paymentDate: string | null | undefined,
  createdAt: string | null | undefined,
  dir: DateTextDir,
  _locale: "ar" | "en" = "en",
): string {
  const datePart = formatIsoDateForDisplay(paymentDate, dir);
  if (!datePart) return "";
  if (!createdAt) return datePart;
  const when = new Date(createdAt);
  if (Number.isNaN(when.getTime())) return datePart;
  const timePart = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(when);
  return `${datePart} ${timePart}`;
}

/** ISO date → Date at local midnight (avoids UTC shift for `yyyy-MM-dd`). */
export function isoToLocalDate(iso: string | null | undefined): Date | undefined {
  if (!iso) return undefined;
  const match = ISO_DATE.exec(iso.slice(0, 10));
  if (!match) return undefined;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!isValidYmd(y, m, d)) return undefined;
  return new Date(y, m - 1, d);
}
