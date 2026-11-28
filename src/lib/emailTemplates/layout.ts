import { escapeHtml } from "@/lib/html";
import { EMAIL_FONT_STACK } from "@/lib/documentFonts";

/**
 * القالب المؤسسي المشترك لرسائل البريد: الألوان، الترويسة، التذييل، وزر الإجراء.
 *
 * Every builder in this directory renders through `wrapLayout`, so the shell
 * lives in one file and the per-message modules only compose inner content.
 */

export type EmailLocale = "ar" | "en";

/**
 * ألوان القالب واسم المنصة الافتراضي.
 *
 * The names are the platform's, not a company's: they are only what the header
 * shows when no send path substituted the company's own name (see
 * `applyEmailBrandName`). They used to be one company's name, printed on every
 * company's mail.
 */
export const BRAND = {
  name_ar: "إيجاري",
  name_en: "IJARY",
  primary: "#0f3d2e",
  accent: "#d4a44c",
  bg: "#f5f2ec",
  text: "#1c1c1c",
  muted: "#6b6b6b",
} as const;

/**
 * علامة موضع الشعار في ترويسة البريد، يستبدلها مسار الإرسال.
 *
 * Declared here because this is the file that emits it, which keeps the
 * dependency one-directional: `emailLogo.ts` imports the marker from this
 * module (through the `@/lib/emailTemplates` re-export), and this module
 * imports nothing back from it. An HTML
 * comment, so a document that never reaches `applyEmailLogo` renders correctly
 * with no logo rather than showing a stray token.
 */
export const EMAIL_LOGO_MARKER = "<!--EMAIL_LOGO-->";

/**
 * علامتا موضع اسم الشركة في ترويسة البريد، يستبدل مسار الإرسال ما بينهما.
 *
 * A pair rather than one marker, so the platform name between them still
 * reads correctly in a document that never reaches the send path. Same reason
 * as `EMAIL_LOGO_MARKER`: sixteen senders build the HTML without knowing the
 * company, and the send path is the one place every email provably reaches.
 */
export const EMAIL_BRAND_NAME_OPEN = "<!--EMAIL_BRAND_NAME-->";
export const EMAIL_BRAND_NAME_CLOSE = "<!--/EMAIL_BRAND_NAME-->";

const BRAND_NAME_SLOT = /<!--EMAIL_BRAND_NAME-->[\s\S]*?<!--\/EMAIL_BRAND_NAME-->/g;

/**
 * اسم المنصة الافتراضي في ترويسة البريد قبل استبداله باسم الشركة.
 *
 * Also the fallback `alt` text of the logo where no company name is known.
 */
export function emailBrandName(locale: EmailLocale): string {
  return locale === "ar" ? BRAND.name_ar : BRAND.name_en;
}

/**
 * يرجع موضع اسم الشركة جاهزاً للإدراج في نص الرسالة، باسم المنصة حتى يُستبدل.
 *
 * Lets a body sentence name the sending company without the builder knowing
 * it: the send path fills every slot, header and body alike.
 */
export function emailBrandSlot(locale: EmailLocale): string {
  return `${EMAIL_BRAND_NAME_OPEN}${escapeHtml(emailBrandName(locale))}${EMAIL_BRAND_NAME_CLOSE}`;
}

/**
 * يضع اسم الشركة المرسلة في ترويسة البريد ونصه مكان اسم المنصة الافتراضي.
 *
 * Pure and synchronous: the template preview runs it in the browser too. A
 * blank or missing name keeps the platform default rather than an empty
 * header (a branding row read without its name columns must not throw). The
 * markers stay around the new name, so substituting again (a resend after the
 * company renamed itself) replaces it rather than nesting.
 */
export function applyEmailBrandName(html: string, brandName: string | null | undefined): string {
  const name = brandName?.trim() ?? "";
  if (!name || !html.includes(EMAIL_BRAND_NAME_OPEN)) return html;
  const slot = `${EMAIL_BRAND_NAME_OPEN}${escapeHtml(name)}${EMAIL_BRAND_NAME_CLOSE}`;
  return html.replace(BRAND_NAME_SLOT, () => slot);
}

export interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

/**
 * يلفّ محتوى الرسالة بالقالب المؤسسي: الترويسة والشعار والتذييل واتجاه اللغة.
 */
export function wrapLayout(locale: EmailLocale, title: string, body: string): string {
  const dir = locale === "ar" ? "rtl" : "ltr";
  const lang = locale;
  const footerNote =
    locale === "ar"
      ? "هذه رسالة تلقائية من نظام إدارة الإيجارات. للتواصل يرجى الاتصال بمكتب الشركة."
      : "This is an automated message from the rental management system. For assistance please contact our office.";
  // Fluid shell: fixed width="600" overflowed on phone screens. max-width + 100%
  // width works in clients that honour inline CSS; the media query tightens
  // padding/CTA where <style> is allowed (Apple Mail, iOS, many Android clients).
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(title)}</title>
<style type="text/css">
  @media only screen and (max-width: 620px) {
    .email-shell { width: 100% !important; max-width: 100% !important; }
    .email-pad { padding-left: 16px !important; padding-right: 16px !important; }
    .email-cta a { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:${EMAIL_FONT_STACK};color:${BRAND.text};direction:${dir};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BRAND.bg};padding:24px 0;width:100%;">
    <tr><td align="center" style="padding:0 12px;">
      <table role="presentation" class="email-shell" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,0.06);">
        <tr>
          <td class="email-pad" style="background:${BRAND.primary};padding:24px 28px;color:#ffffff;">
            ${EMAIL_LOGO_MARKER}<div style="font-size:20px;font-weight:700;letter-spacing:0.3px;">${emailBrandSlot(locale)}</div>
            <div style="font-size:12px;opacity:0.85;margin-top:4px;">${escapeHtml(title)}</div>
          </td>
        </tr>
        <tr>
          <td class="email-pad" style="padding:28px;font-size:15px;line-height:1.7;word-break:break-word;overflow-wrap:anywhere;">
            ${body}
          </td>
        </tr>
        <tr>
          <td class="email-pad" style="background:${BRAND.bg};padding:16px 28px;font-size:12px;color:${BRAND.muted};text-align:center;border-top:1px solid #e6e2da;">
            ${escapeHtml(footerNote)}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Composes a finished email document from a body.
 *
 * The single place the shell decision is made, so the senders and the admin
 * preview cannot disagree about what an email will look like.
 *
 * A body that STARTS as an HTML document is used verbatim — the escape hatch for
 * an admin who wants total control of one email. Note that skipping wrapLayout
 * also skips the `dir` it sets, so a full-document Arabic template must carry
 * its own dir="rtl". Anything else is inner content and gets the branded shell.
 */
export function renderEmailDocument(locale: EmailLocale, title: string, bodyHtml: string): string {
  if (/^\s*(<!doctype|<html)/i.test(bodyHtml)) return bodyHtml;
  return wrapLayout(locale, title, bodyHtml);
}

/**
 * يرسم زر دعوة إلى إجراء بلون العلامة داخل جسم الرسالة.
 */
export function button(locale: EmailLocale, href: string, label: string): string {
  return `<div class="email-cta" style="text-align:center;margin:24px 0;">
    <a href="${escapeAttr(href)}" style="display:inline-block;background:${BRAND.accent};color:#1c1c1c;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:8px;max-width:100%;box-sizing:border-box;">
      ${escapeHtml(label)}
    </a>
  </div>`;
}

/**
 * يهرّب قيمة لاستخدامها داخل سمة HTML.
 */
function escapeAttr(value: string): string {
  return escapeHtml(value);
}
