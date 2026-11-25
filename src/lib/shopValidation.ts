/**
 * التحقق من روابط المتجر قبل الحفظ — يمنع `javascript:` ومهاجمات XSS المخزنة.
 *
 * `instagram_url` و `website_url` يُكتبان مباشرة في خاصية `href` على الصفحة
 * العامة (src/routes/index.tsx ~1826). لو سُمح لـ `javascript:` بالمرور فإن
 * مستأجراً واحداً يستطيع تنفيذ سكربت على كل زائر. لذلك يُسمح فقط بـ
 * `http:` و `https:`، ويُطبق التحقق في العميل وفي دالة RPC على الخادم.
 */

const HTTP_PROTOCOL = /^https?:\/\//i;
const MAX_URL_LENGTH = 2048;

/**
 * يتحقق مما إذا كان الرابط صالحاً — فارغ أو يبدأ بـ http/https فقط.
 */
export function isValidShopUrl(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return true;
  if (trimmed.length > MAX_URL_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return false;
  return HTTP_PROTOCOL.test(trimmed);
}

/**
 * يطبّع الرابط بعد التحقق، أو يرمي خطأً برسالة قابلة للعرض.
 */
export function assertValidShopUrl(value: string | null | undefined, field: string): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (!isValidShopUrl(trimmed)) {
    throw new Error(`${field} must start with http:// or https://`);
  }
  return trimmed;
}
