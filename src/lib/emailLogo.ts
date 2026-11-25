import { EMAIL_LOGO_MARKER } from "@/lib/emailTemplates";
import { escapeHtml } from "@/lib/html";

export { EMAIL_LOGO_MARKER };

/**
 * يستبدل علامة الشعار بصورة الشعار، أو يزيلها إن لم يكن هناك شعار.
 *
 * Pure and synchronous on purpose: `wrapLayout` runs in the browser too, from
 * the template preview, so nothing on this path may fetch. The caller resolves
 * the URL — from `getPublicBranding()` on the server, from `useCompany()` in the
 * preview — and hands it in.
 *
 * Why a marker rather than a `logoUrl` parameter threaded through the builders:
 * `dispatchNotification` does not build HTML. It sends `notification.body`, a
 * string sixteen separate sender files produced. A parameter would have to be
 * added to all sixteen and remembered in every sender written afterwards, and
 * one forgotten sender is an unbranded email nobody notices. The substitution
 * belongs at the send path, which every email provably reaches.
 */
export function applyEmailLogo(
  html: string,
  logoUrl: string | null | undefined,
  brandName: string,
): string {
  if (!html.includes(EMAIL_LOGO_MARKER)) return html;
  const trimmed = logoUrl?.trim();
  const replacement = trimmed
    ? `<img src="${escapeHtml(trimmed)}" alt="${escapeHtml(brandName)}" ` +
      `style="max-height:44px;max-width:200px;display:block;margin-bottom:12px;border:0;" />`
    : "";
  // split/join rather than replace: a string pattern replaces only the first
  // occurrence, and `$&`-style sequences inside a URL would be read as
  // replacement patterns.
  return html.split(EMAIL_LOGO_MARKER).join(replacement);
}
