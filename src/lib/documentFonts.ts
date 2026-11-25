/**
 * مصدر واحد لخطوط المستندات وقاعدة تباعد الحروف التي تحمي العربية.
 *
 * Five renderers used to answer "what font renders Arabic" five different ways
 * in string literals — Noto Naskh in the server PDF, Noto Sans in browser
 * print, and no Arabic face at all in the three email builders — so a receipt
 * printed from the browser and the same receipt in the tenant's inbox looked
 * like two documents. Changing the typeface meant finding six literals, half in
 * files nobody associates with typography.
 */

/**
 * خط المستندات التي يطبعها المتصفح أو يلتقطها html2canvas.
 *
 * Latin faces first, then Noto Sans Arabic: the browser shapes Arabic with the
 * first face that has the glyphs, and Segoe UI / Tahoma cover Latin and digits
 * on the office's Windows machines.
 */
export const ARABIC_FONT_STACK = `"Segoe UI", Tahoma, Arial, "Noto Sans Arabic", sans-serif`;

/**
 * خط ملفات PDF التي يرسمها Chromium على الخادم.
 *
 * Different from ARABIC_FONT_STACK on purpose: it names only the families
 * installed in the runtime image (fonts-noto-core → Noto Naskh Arabic and Noto
 * Sans; fonts-dejavu-core → DejaVu Sans for Latin and digits in mixed reports).
 * A face the container does not have would silently fall back to whatever
 * Chromium finds, which is how an Arabic PDF ends up in boxes.
 */
export const PDF_FONT_STACK = `"Noto Naskh Arabic", "Noto Sans", "DejaVu Sans", sans-serif`;

/**
 * خط رسائل البريد: وجه يدعم العربية أولاً، ثم وجوه الأنظمة الشائعة.
 *
 * Mail clients strip webfonts, so every face here is a system font. Tahoma
 * ships with Arabic on Windows and Outlook, Geeza Pro is the Arabic face on
 * Apple Mail, Noto Sans Arabic on Android/Gmail; Arial is the last Latin
 * resort. Single-quoted so it can sit inside a double-quoted `style` attribute.
 * Before this the email stacks named no Arabic face at all and each client
 * picked its own (user decision M17, 2026-09-23).
 */
export const EMAIL_FONT_STACK = `Tahoma, 'Segoe UI', 'Geeza Pro', 'Noto Sans Arabic', Arial, sans-serif`;

/**
 * القاعدة التي تمنع تفكك الحروف العربية عند الالتقاط إلى صورة أو PDF.
 *
 * Load-bearing, not cosmetic. html2canvas 1.4.1 — and Chromium's PDF path on
 * the server — draw a text run one grapheme at a time whenever the computed
 * letter-spacing is non-zero, so each Arabic letter is painted in its isolated
 * form and RTL runs come out reversed. `normal` takes the single-fillText
 * branch that lets the canvas shape the run. It must be `!important` and
 * universal: report cards built in SQL set letter-spacing inline, and only an
 * important author rule outranks that. The full trace of the html2canvas code
 * path is on PDF_CAPTURE_CSS in printDocument.ts.
 */
export const ARABIC_SAFE_CSS = `* { letter-spacing: normal !important; }`;

/**
 * أساس رابط خط Cairo كما يخدمه خادم الويب للمتصفح من مجلد public.
 *
 * Kept as a named constant — not the literal — because serverPdf.ts matches
 * this exact prefix when it rebases the URL for the file-rendered PDF; a
 * literal on one side and a constant on the other is how the rewrite silently
 * stops matching after a "harmless" rename.
 */
export const CAIRO_PUBLIC_FONTS_BASE = "/fonts";

/**
 * يبني قاعدتي @font-face لخط Cairo (عادي وثقيل) من الأساس المعطى للرابط.
 *
 * Static instances pinned to 400 and 700: the contract's 800-weight headers
 * resolve to the real Bold face (closest match) instead of a synthesised
 * bold of Regular, which Chromium draws noticeably wider in justified
 * paragraphs. The base is caller-resolved on purpose (decision D6): the
 * browser serves these from `/fonts`, but the server PDF is rendered from a
 * temp file where a root-relative URL cannot resolve — the caller passes the
 * absolute `file://` directory there, and `font-display: swap` keeps the
 * letterhead visible in the browser preview until the face loads.
 */
export function cairoFontFace(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `@font-face {
    font-family: "Cairo";
    src: url("${base}/Cairo-Regular.ttf") format("truetype");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "Cairo";
    src: url("${base}/Cairo-Bold.ttf") format("truetype");
    font-weight: 700;
    font-style: normal;
    font-display: swap;
  }`;
}
