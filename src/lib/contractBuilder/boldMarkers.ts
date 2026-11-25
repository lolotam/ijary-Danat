export const BOLD_OPEN = "\u0001";
export const BOLD_CLOSE = "\u0002";

/**
 * يزيل علامات الخط العريض لقياس طول النص الفعلي أو قبل إعادة تعليم القيمة.
 *
 * The schema has no shared string sanitizer (`refineSecondParty` discards its
 * parsed output), so a typed sentinel must be removed before it can open a
 * `<strong>` the operator did not ask for.
 */
export function stripBoldMarkers(text: string): string {
  return text.split(BOLD_OPEN).join("").split(BOLD_CLOSE).join("");
}

/**
 * يعلّم قيمة مُدخلة من النموذج لتُطبع بخط عريض في العقد.
 *
 * Clause functions return plain strings that html.ts escapes whole, so a
 * literal <strong> would print as text. Control characters survive escaping
 * untouched and cannot survive this wrapper: they are stripped first.
 */
export function v(value: string | number): string {
  return `${BOLD_OPEN}${stripBoldMarkers(String(value))}${BOLD_CLOSE}`;
}

/**
 * يحوّل العلامات في نص مُهرَّب مسبقاً إلى وسوم <strong>.
 *
 * The pattern is built from the marker constants: a regex literal containing
 * those control characters is rejected by no-control-regex.
 */
export function renderBold(escaped: string): string {
  const marked = new RegExp(`${BOLD_OPEN}([^${BOLD_OPEN}${BOLD_CLOSE}]*)${BOLD_CLOSE}`, "g");
  return escaped.replace(marked, "<strong>$1</strong>");
}
