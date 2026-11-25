/**
 * حارس النماذج العامة: حدّ سرعة واحد في الذاكرة لكل نقطة نهاية عامة.
 *
 * The public contact and leasing forms are unauthenticated and write with the
 * service-role client, so without a limit a single client can flood the table
 * and the admin inbox. The app runs as a single container (Dokploy), so an
 * in-memory window is sufficient; swap for a shared store if scaled out. Note
 * the window resets on redeploy.
 *
 * The `ip` argument is expected to come from `clientAddress(request)`, which
 * prefers `cf-connecting-ip`. The limiter this replaces keyed on the first
 * `x-forwarded-for` element — a value the client itself can set, because
 * Cloudflare and Traefik append to that header rather than replace it — so a
 * rotating forged header minted a fresh bucket per request and the limit never
 * fired (audit H6). Keying on a client-supplied header is what made the
 * previous limiter a no-op, which is why the bucket key here must originate
 * from `cf-connecting-ip`.
 */

/** طول نافذة الحد بالمللي ثانية — ساعة واحدة، كما كان قبل الاستخراج. */
export const PUBLIC_FORM_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const RATE_LIMIT_MAX_PER_WINDOW = 5;

const submissionsByKey = new Map<string, number[]>();

/**
 * يسجّل محاولة إرسال في النموذج المسمّى ويرجّع true إذا رُفض الطلب لتجاوز الحد.
 *
 * Each endpoint names its own bucket, so a contact submission never consumes a
 * leasing submission's quota — the two endpoints held separate Maps before
 * this helper existed, and audit M11 records that independence as deliberate.
 *
 * A refused request does not extend the window: on refusal the filtered list
 * is re-stored *without* pushing `now`, so the window is measured from the
 * last accepted request and a steady flood cannot push it forward forever.
 * `now` exists as a parameter only so tests can move the clock without
 * sleeping; production callers omit it.
 */
export function rateLimitPublicForm(bucket: string, ip: string, now: number = Date.now()): boolean {
  const key = `${bucket}:${ip}`;
  const recent = (submissionsByKey.get(key) ?? []).filter(
    (ts) => now - ts < PUBLIC_FORM_RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MAX_PER_WINDOW) {
    submissionsByKey.set(key, recent);
    return true;
  }
  recent.push(now);
  submissionsByKey.set(key, recent);
  return false;
}
