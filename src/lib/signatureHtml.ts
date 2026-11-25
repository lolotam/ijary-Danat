// Escaping happens at build time, not at render time: the stored HTML is what
// gets emailed *and* what another admin's browser previews, so an unescaped
// value is stored XSS rather than a display bug.
import { escapeHtml } from "@/lib/html";
import { EMAIL_FONT_STACK } from "@/lib/documentFonts";

/**
 * الحقول المنظّمة التي يُبنى منها التوقيع.
 *
 * Stored alongside the rendered HTML rather than parsed back out of it. The
 * reference implementation this is modelled on regex-parsed its own output to
 * repopulate the edit form, which returns confidently wrong data as soon as the
 * stored markup stops matching the template that produced it.
 */
export interface SignatureDetails {
  logoUrl: string;
  fullName: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
}

export const EMPTY_SIGNATURE_DETAILS: SignatureDetails = {
  logoUrl: "",
  fullName: "",
  title: "",
  company: "",
  phone: "",
  email: "",
  website: "",
};

/**
 * يقبل روابط الويب والبريد فقط، ويرفض أي مخطّط آخر.
 *
 * `escapeHtml` stops a value breaking *out* of the attribute; it does nothing
 * about what the attribute then means. `javascript:alert(1)` contains none of
 * the escaped characters, so it survives intact and becomes a live href that
 * runs in the next admin's privileged session when they click the signature.
 *
 * A bare domain is upgraded to https rather than rejected — admins type
 * "danat-future.com", and silently dropping their website is worse than
 * guessing the scheme they meant. Anything else returns empty and the link is
 * omitted entirely.
 */
function safeWebHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  // No scheme at all and no control characters — treat it as a bare domain.
  if (/^[\w.-]+\.[a-z]{2,}(?:[/?#][^\s]*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return "";
}

/**
 * يقبل مصادر الصور الآمنة فقط — رابط ويب أو صورة مضمّنة.
 *
 * Same reasoning as safeWebHref. `img src` is a weaker vector than `href` in
 * current browsers, but the stored HTML is emailed and previewed elsewhere, and
 * a scheme allow-list costs nothing.
 */
function safeImageSrc(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(trimmed)) return trimmed;
  return "";
}

/**
 * يبني HTML التوقيع من الحقول، ويتجاهل كل حقل فارغ.
 *
 * A table with inline styles rather than a flex div with classes: mail clients
 * strip <style> blocks and many still do not lay out flexbox. Every
 * email-signature generator emits this shape, for that reason.
 *
 * Returns an empty string when there is nothing to show, so callers can treat
 * "no signature" and "an empty signature" identically.
 */
export function buildSignatureHtml(details: SignatureDetails): string {
  const lines: string[] = [];
  if (details.fullName) {
    lines.push(
      `<strong style="font-size:14px;color:#333;">${escapeHtml(details.fullName)}</strong>`,
    );
  }
  if (details.title) {
    lines.push(`<span style="color:#666;font-size:12px;">${escapeHtml(details.title)}</span>`);
  }
  if (details.company) {
    lines.push(`<span style="color:#666;font-size:12px;">${escapeHtml(details.company)}</span>`);
  }

  const contact = [details.phone, details.email].filter(Boolean).map(escapeHtml);
  if (contact.length) {
    lines.push(`<span style="font-size:12px;color:#333;">${contact.join(" | ")}</span>`);
  }
  const websiteHref = safeWebHref(details.website);
  if (websiteHref) {
    // The link text is the value the admin typed; the href is the vetted one.
    // Showing the raw text keeps the signature honest when the scheme was
    // upgraded, while the attribute can only ever be http, https or mailto.
    lines.push(
      `<a href="${escapeHtml(websiteHref)}" style="font-size:12px;color:#0066cc;text-decoration:none;">${escapeHtml(details.website.trim())}</a>`,
    );
  }

  const logoSrc = safeImageSrc(details.logoUrl);
  if (!lines.length && !logoSrc) return "";

  const logoCell = logoSrc
    ? `<td style="padding-inline-end:15px;vertical-align:top;"><img src="${escapeHtml(logoSrc)}" alt="" width="80" style="border-radius:4px;display:block;" /></td>`
    : "";
  // Logical properties so the divider sits beside the logo in both directions —
  // this signature is as likely to sit under Arabic as under English.
  const divider = logoSrc ? "border-inline-start:2px solid #0066cc;padding-inline-start:15px;" : "";

  return `<table cellpadding="0" cellspacing="0" style="font-family:${EMAIL_FONT_STACK};"><tr>${logoCell}<td style="vertical-align:top;${divider}">${lines.join("<br/>")}</td></tr></table>`;
}

/**
 * السمة التي تميّز كتلة التوقيع داخل نص الرسالة.
 *
 * The signature now lives *in* the compose body so the admin can see it before
 * sending, which means selecting a second signature has to find and replace the
 * first one. A marker on the element is what makes that possible; matching "the
 * only table in the document" would delete a table the admin had pasted.
 */
export const SIGNATURE_BLOCK_ATTR = "data-signature-block";

const SIGNATURE_DIVIDER_STYLE =
  "margin-top:20px;padding-top:10px;border-top:1px solid #e5e5e5;color:#666;font-size:14px;";

/**
 * يضع سمة التوقيع وفاصله العلوي على جدول التوقيع نفسه.
 *
 * The divider used to sit on a wrapping `<div>`. The compose editor's schema has
 * no `div` node, so ProseMirror dropped the wrapper and the marker with it —
 * which is why the marker rides on the signature's own `<table>` instead. Pure
 * string work, no DOM: this has to run in the node-environment test suite.
 *
 * Anything that is not a table still gets a marked table wrapper, so signatures
 * stored before this change stay replaceable rather than accumulating.
 */
export function markSignatureBlock(html: string): string {
  if (!html) return "";
  const marker = `${SIGNATURE_BLOCK_ATTR}="1"`;
  const marked = html.replace(
    /^(\s*)<table\b([^>]*)>/i,
    (_match, lead: string, attributes: string) =>
      `${lead}<table ${marker}${mergeStyleAttribute(attributes)}>`,
  );
  if (marked !== html) return marked;
  return `<table ${marker} style="${SIGNATURE_DIVIDER_STYLE}"><tr><td>${html}</td></tr></table>`;
}

/**
 * يدمج فاصل التوقيع مع تنسيق الجدول القائم بدل استبداله.
 *
 * The generated signature table already carries its own font rules; replacing
 * the attribute outright would drop them.
 */
function mergeStyleAttribute(attributes: string): string {
  const existing = attributes.match(/\sstyle="([^"]*)"/i);
  if (!existing) return `${attributes} style="${SIGNATURE_DIVIDER_STYLE}"`;
  const merged = `${SIGNATURE_DIVIDER_STYLE}${existing[1]}`;
  return attributes.replace(existing[0], ` style="${merged}"`);
}

/**
 * يزيل كتلة التوقيع من نص الرسالة، ويترك ما عداها كما هو.
 *
 * Counts table depth rather than matching to the first `</table>`. A signature
 * stored as something other than a table gets a table wrapper above, and if
 * that content itself holds a table, a non-greedy match stops at the inner
 * closing tag and leaves a stray `</table>` behind — which then corrupts the
 * message the next time a signature is picked.
 *
 * Works on the body's HTML rather than an editor transaction so it stays
 * testable in this project's node-environment suite, where there is no DOM.
 */
export function stripSignatureBlock(html: string): string {
  const openTag = new RegExp(`<table[^>]*\\b${SIGNATURE_BLOCK_ATTR}\\b[^>]*>`, "i");
  let result = html;

  for (;;) {
    const start = result.search(openTag);
    if (start === -1) return result;

    const end = findTableEnd(result, start);
    // An unclosed signature table means the body is already malformed; removing
    // to the end of the string would take the admin's text with it.
    if (end === -1) return result;
    result = result.slice(0, start) + result.slice(end);
  }
}

/**
 * يحدّد نهاية الجدول المفتوح عند الموضع المعطى، مع مراعاة الجداول المتداخلة.
 *
 * Returns the index just past the matching `</table>`, or -1 when the table is
 * never closed.
 */
function findTableEnd(html: string, start: number): number {
  const tags = /<(\/?)table\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;

  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return -1;
}

/**
 * يستبدل توقيع الرسالة بالتوقيع الجديد، أو يزيله عند عدم اختيار أي توقيع.
 */
export function applySignatureToBody(bodyHtml: string, signatureHtml: string): string {
  const withoutSignature = stripSignatureBlock(bodyHtml);
  if (!signatureHtml) return withoutSignature;
  return `${withoutSignature}${markSignatureBlock(signatureHtml)}`;
}
