/**
 * كل مُصيِّر يرسل الخط الموحَّد وقاعدة حماية العربية فعلاً، لا نص `${…}` حرفياً.
 *
 * The constants only matter if they reach the output. These assert on what
 * each renderer actually emits, so a stack moved into a plain string (where
 * `${EMAIL_FONT_STACK}` would ship literally) fails here rather than in an
 * inbox.
 */
import { describe, expect, it } from "vitest";

import { AR_MESSAGE, buildEmailBody } from "@/lib/companyInfoMessage";
import { ARABIC_SAFE_CSS, EMAIL_FONT_STACK, PDF_FONT_STACK } from "@/lib/documentFonts";
import { renderEmailDocument } from "@/lib/emailTemplates";
import { PDF_CAPTURE_CSS } from "@/lib/printDocument";
import { wrapHtmlForPdf } from "@/lib/serverPdf";
import { buildSignatureHtml, EMPTY_SIGNATURE_DETAILS } from "@/lib/signatureHtml";

describe("email renderers name an Arabic-capable face", () => {
  it("the email stack leads with a face that ships Arabic glyphs", () => {
    // User decision M17: before this the three email stacks named none.
    expect(EMAIL_FONT_STACK.split(",")[0].trim()).toBe("Tahoma");
    expect(EMAIL_FONT_STACK).toContain("'Noto Sans Arabic'");
  });

  it("renderEmailDocument emits the stack, not a literal placeholder", () => {
    const html = renderEmailDocument("ar", "عنوان", "<p>مرحبا</p>");
    expect(html).toContain(`font-family:${EMAIL_FONT_STACK}`);
    expect(html).not.toContain("${");
  });

  it("the company-info message emits the stack", () => {
    const html = buildEmailBody(AR_MESSAGE, {} as never, undefined, "ar");
    expect(html).toContain(`font-family:${EMAIL_FONT_STACK}`);
  });

  it("the signature emits the stack", () => {
    const html = buildSignatureHtml({ ...EMPTY_SIGNATURE_DETAILS, fullName: "وليد" });
    expect(html).toContain(`font-family:${EMAIL_FONT_STACK}`);
  });
});

describe("both capture paths carry the Arabic glyph-joining reset", () => {
  it("the browser html2canvas CSS includes it", () => {
    expect(PDF_CAPTURE_CSS).toContain(ARABIC_SAFE_CSS);
  });

  it("the server Chromium document includes it and the shipped font stack", () => {
    const html = wrapHtmlForPdf("<p>مرحبا</p>");
    expect(html).toContain(ARABIC_SAFE_CSS);
    expect(html).toContain(PDF_FONT_STACK);
  });
});
