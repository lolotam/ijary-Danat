/**
 * Strips characters that would break a PostgREST filter out of a user's search
 * term, leaving something safe to interpolate into `ilike`.
 *
 * Allowed: letters, numbers, whitespace, and `@ . _ + : -`.
 *
 * `:` was added because payment references are stored as
 * `AUTO-INV:<invoice code>`, so rewriting the colon to a space made
 * `reference.ilike.%AUTO-INV INV-0000286%` — a pattern that matches nothing.
 * PostgREST does not reserve `:` inside a filter value; verified against the
 * live endpoint, which parses it rather than returning 400.
 *
 * Still stripped are the characters that break out of an `or=(...)` list — `,`
 * `(` `)` and quotes — and the `%` wildcard, so a term cannot widen its own
 * pattern. Note `_` (ilike's single-character wildcard) and `.` survive; that
 * predates this helper's current form and is harmless, since PostgREST splits
 * `column.operator.value` on the first two dots and treats the rest as literal.
 *
 * `-` must remain last in the character class to stay a literal, not a range.
 */
export function normalizePostgrestSearch(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}\s@._+:-]/gu, " ")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}
