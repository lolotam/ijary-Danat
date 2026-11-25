/**
 * المصدر الوحيد لاستخراج عنوان الزائر في التطبيق.
 *
 * Extracted verbatim from `loginAudit.ts` (audit H6/M11) so the login audit
 * and the public-form rate limiters read the caller through the same reviewed
 * header order instead of each re-deriving it — the endpoint copies derived
 * the address differently and were bypassable for it.
 */

/**
 * يستخرج عنوان الزائر الحقيقي من ترويسات الطلب.
 *
 * Behind Cloudflare `cf-connecting-ip` is the address Cloudflare itself
 * observed and the one worth keeping; `x-forwarded-for` is appended to by every
 * hop, so only its first element is the client. Either way one address comes
 * out.
 */
export function clientAddress(request: Request): string | null {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct) return direct;
  const chain = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return chain || null;
}
