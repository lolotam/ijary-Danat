/**
 * يهرّب قيمة نصية لتُدرج داخل HTML بأمان — نصاً أو قيمة سمة بعلامتي تنصيص مفردة أو مزدوجة.
 *
 * This is the XSS boundary for admin-authored template bodies and tenant data,
 * and it used to be implemented six times: three escaped the apostrophe and
 * three did not, and nothing at a call site said which one you had. None was
 * exploitable only because no single-quoted interpolated attribute existed yet
 * — one `style='…'` away from mattering. One implementation, all five
 * characters, `&` first so the entities the later replacements produce are not
 * themselves re-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
