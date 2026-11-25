/**
 * قرار إعادة المحاولة لاستعلامات React Query.
 *
 * React Query's default is three retries for every failure, which is right for
 * a dropped connection and wrong for everything else. The Roles screen made the
 * difference visible: `custom_roles` does not exist in production, so one visit
 * fired thirteen requests asking the same doomed question — a missing table is
 * not going to appear between attempt one and attempt four.
 *
 * The rule is the ordinary one: retry what might succeed next time (a socket
 * that dropped, a gateway that blinked, a rate limit that will lift), and fail
 * once on anything the server has already decided.
 */

/** عدد المحاولات الإضافية للأخطاء العابرة. */
export const MAX_QUERY_RETRIES = 2;

/**
 * رموز حالة HTTP ضمن 4xx التي تستحق إعادة المحاولة رغم ذلك.
 *
 * 408 and 504 are timeouts, 425 is "too early", 429 is a rate limit that lifts
 * on its own. Every other 4xx is the server stating a fact about the request.
 */
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 504]);

/**
 * فئات SQLSTATE التي لا تتغير بإعادة المحاولة.
 *
 * `42` is syntax and access violations — an undefined table (42P01) or a
 * refused privilege (42501). `22` is invalid data, `23` an integrity
 * violation, `28` a rejected authorization. None of them are timing.
 */
const PERMANENT_SQLSTATE_CLASSES = ["42", "22", "23", "28"];

/**
 * رموز PostgREST العابرة التي تستحق إعادة المحاولة رغم أنها من عائلة PGRST.
 *
 * Group 0 is PostgREST's own infrastructure: PGRST000 could not connect to the
 * database, PGRST001 an internal pool error, PGRST002 the schema cache failed
 * to load, PGRST003 the request timed out. Those surface during a restart or a
 * connection blip and clear on their own — the opposite of the refusals this
 * module exists to stop retrying. PGRST301 is an expired JWT, which a retry
 * carries a fresh copy of.
 *
 * Review finding on PR #206: without this list the blanket `PGRST` branch below
 * classified a database restart as permanent, so a query that would have
 * succeeded a second later failed outright.
 */
const RETRYABLE_POSTGREST_CODES = new Set([
  "PGRST000",
  "PGRST001",
  "PGRST002",
  "PGRST003",
  "PGRST301",
]);

/** يستخرج رمز حالة HTTP من خطأ إن حمله. */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const value = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  return typeof value === "number" ? value : null;
}

/** يستخرج رمز خطأ PostgREST أو PostgreSQL إن وُجد. */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * يحدّد ما إذا كان الخطأ نهائياً فلا جدوى من تكراره.
 *
 * PostgREST's own `PGRST…` codes all describe a request the server understood
 * and refused — a missing table in the schema cache (PGRST205), an RPC that
 * does not exist (PGRST202), a malformed filter. The one case worth excluding
 * is a JWT that expired mid-flight, which a refreshed session does fix.
 */
export function isPermanentQueryError(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== null && status >= 400 && status < 500) {
    return !RETRYABLE_HTTP_STATUS.has(status);
  }

  const code = errorCodeOf(error);
  if (!code) return false;

  if (RETRYABLE_POSTGREST_CODES.has(code)) return false;
  if (/^PGRST\d+$/.test(code)) return true;

  return PERMANENT_SQLSTATE_CLASSES.includes(code.slice(0, 2));
}

/**
 * دالة إعادة المحاولة التي يمرّرها الموجّه إلى React Query.
 *
 * **`failureCount` is zero-based.** query-core 5.101.1 calls this predicate and
 * only then increments its counter (`retryer.ts`: `retry(failureCount, error)`
 * on one line, `failureCount++` on the next), so the first failure arrives as
 * 0. Review finding on PR #206: `<=` therefore permitted three further attempts
 * where `MAX_QUERY_RETRIES` promises two, and the original test began its
 * assertions at 1, which hid the off-by-one entirely.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isPermanentQueryError(error)) return false;
  return failureCount < MAX_QUERY_RETRIES;
}
