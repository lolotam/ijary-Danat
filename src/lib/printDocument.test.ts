import { describe, expect, it } from "vitest";

// PDF libraries (html2canvas + jsPDF) are loaded dynamically inside
// downloadHtmlAsPdf only — pure HTML-shaping helpers import cleanly here.
import { PDF_CAPTURE_CSS, PDF_FRAME_SANDBOX, toPrintableHtml } from "./printDocument";

/**
 * Regression tests for WSR-001.
 *
 * `generated_reports.html_content` is built by SQL string concatenation from
 * company-controlled text, so it must be treated as untrusted. Every path that
 * renders it (preview tab, print, hidden PDF frame) runs in the application
 * origin, where a script would reach the admin's Supabase session in
 * localStorage. These tests pin the two controls that stop execution.
 */
describe("printDocument — untrusted report HTML cannot execute script", () => {
  const PAYLOAD = `<img src=x onerror="document.title='XSS'">`;

  it("injects a script-blocking CSP into a full HTML document", () => {
    const hostile = `<!doctype html><html><head><style>body{color:red}</style></head><body><h1>${PAYLOAD}</h1></body></html>`;

    const out = toPrintableHtml(hostile, { title: "Report" });

    expect(out).toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    expect(out).toMatch(/script-src 'none'/);
  });

  it("injects a script-blocking CSP into a wrapped fragment", () => {
    const out = toPrintableHtml(`<section>${PAYLOAD}</section>`, { title: "Report" });

    expect(out).toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    expect(out).toMatch(/script-src 'none'/);
  });

  it("places the CSP before any other head content so it governs the document", () => {
    const hostile = `<!doctype html><html><head><style>body{color:red}</style></head><body>${PAYLOAD}</body></html>`;

    const out = toPrintableHtml(hostile, { title: "Report" });

    const cspIndex = out.search(/Content-Security-Policy/i);
    const styleIndex = out.search(/<style/i);
    const bodyIndex = out.search(/<body/i);

    expect(cspIndex).toBeGreaterThan(-1);
    expect(cspIndex).toBeLessThan(styleIndex);
    expect(cspIndex).toBeLessThan(bodyIndex);
  });

  it("blocks plugin, base-tag and form-submission escapes as well", () => {
    const out = toPrintableHtml(`<p>${PAYLOAD}</p>`, { title: "Report" });

    expect(out).toMatch(/object-src 'none'/);
    expect(out).toMatch(/base-uri 'none'/);
    expect(out).toMatch(/form-action 'none'/);
  });

  it("sandboxes the PDF capture frame without granting script execution", () => {
    // html2canvas reads the frame's DOM from the parent, so the frame must stay
    // same-origin. It must never gain allow-scripts.
    expect(PDF_FRAME_SANDBOX).toContain("allow-same-origin");
    expect(PDF_FRAME_SANDBOX).not.toContain("allow-scripts");
  });
});

/**
 * Regression tests for broken Arabic in downloaded PDFs.
 *
 * html2canvas 1.4.1 renders a text run one grapheme at a time whenever the
 * computed letter-spacing is non-zero (`renderTextWithLetterSpacing`,
 * dist/html2canvas.js:6703). Drawing Arabic glyph-by-glyph loses contextual
 * shaping — every letter falls back to its isolated form — and the draw cursor
 * advances left-to-right, so RTL runs also come out reversed.
 *
 * The report card labels in db/migrations/44 ("Collected / التحصيل",
 * "Expenses / المصروفات", …) carry inline `letter-spacing: 0.06em`, which is
 * exactly why those cards broke while unspaced Arabic rendered fine.
 */
describe("printDocument — Arabic survives PDF rasterization", () => {
  // Mirrors the .label-caps markup emitted by build_scheduled_report_html.
  const CARD_LABEL = `<div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Collected / التحصيل</div>`;

  it("forces letter-spacing back to normal on the PDF capture path", () => {
    // `normal` parses to 0 in html2canvas (dist/html2canvas.js:2778), which
    // routes the run through a single fillText() that shapes Arabic correctly.
    expect(PDF_CAPTURE_CSS).toMatch(/letter-spacing:\s*normal\s*!important/);
  });

  it("applies the override to every element, not just known card classes", () => {
    // The trigger is the CSS property, not any particular selector, so the rule
    // has to be universal to cover future report and invoice markup.
    expect(PDF_CAPTURE_CSS).toMatch(/\*[^{]*\{[^}]*letter-spacing:\s*normal\s*!important/);
  });

  it("outranks the inline letter-spacing the report cards carry", () => {
    const out = toPrintableHtml(CARD_LABEL, { extraCss: PDF_CAPTURE_CSS });

    // An !important author rule beats a normal inline declaration, but only if
    // the stylesheet actually reaches the document.
    expect(out).toContain("letter-spacing: normal !important");
    expect(out).toContain("letter-spacing:0.06em");
    expect(out.search(/letter-spacing:\s*normal\s*!important/)).toBeLessThan(
      out.search(/letter-spacing:0\.06em/),
    );
  });

  it("leaves the print and preview paths untouched", () => {
    // Those render through the browser's own text engine, which shapes Arabic
    // correctly at any letter-spacing. The intentional tracking should survive.
    const out = toPrintableHtml(CARD_LABEL, { title: "Report" });

    expect(out).not.toMatch(/letter-spacing:\s*normal\s*!important/);
  });
});
