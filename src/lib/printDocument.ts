import { escapeHtml } from "@/lib/html";
import { ARABIC_FONT_STACK, ARABIC_SAFE_CSS } from "@/lib/documentFonts";

/**
 * Full-page HTML print / PDF helpers.
 *
 * Important: do NOT open with `noopener` and then try document.write — modern
 * browsers open a blank tab and return a window we cannot write into (or null).
 * Content is loaded via a Blob URL so the tab always shows the document.
 *
 * Download PDF renders the HTML to a real .pdf file; html2canvas + jsPDF are
 * loaded on demand so routes that only preview or print never pay for them.
 */

/**
 * Report and invoice HTML is assembled by SQL string concatenation from
 * company-controlled text, so it is untrusted. Every render path below runs in
 * the application origin, where a script could read the Supabase session from
 * localStorage. A meta CSP is the only control that works for a top-level blob
 * document (a tab cannot carry a `sandbox` attribute), and omitting
 * 'unsafe-inline' also disables inline event handlers such as `onerror`.
 * It must be emitted before any other head content to govern the document.
 */
const PRINT_CSP = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;

/**
 * Sandbox for the hidden PDF capture frame. `allow-same-origin` is required so
 * html2canvas can read the frame's DOM from the parent; `allow-scripts` must
 * never be added — together the two would let the frame drop its own sandbox.
 */
export const PDF_FRAME_SANDBOX = "allow-same-origin";

/**
 * Styles that apply only when rasterizing to a PDF — never to print or preview,
 * which go through the browser's own text engine and need no help.
 *
 * The letter-spacing reset is load-bearing, not cosmetic. html2canvas 1.4.1
 * draws a text run one grapheme at a time whenever the computed letter-spacing
 * is non-zero (`renderTextWithLetterSpacing`, dist/html2canvas.js:6703):
 *
 *   segmentGraphemes(text).reduce((left, letter) => {
 *     ctx.fillText(letter, left, ...);
 *     return left + ctx.measureText(letter).width;
 *   }, bounds.left)
 *
 * That breaks Arabic twice over — each letter is painted alone so it renders in
 * its isolated form instead of joining, and the cursor always advances to the
 * right, reversing RTL runs. `normal` parses to 0 (dist/html2canvas.js:2778),
 * taking the `letterSpacing === 0` branch that paints the whole run with a
 * single fillText() and lets the canvas shape and reorder it correctly.
 *
 * It must be `!important` and universal: the report cards built by
 * db/migrations/44 (`Collected / التحصيل`, `Expenses / المصروفات`, …) set
 * letter-spacing inline, and an important author rule is what outranks a normal
 * inline declaration. Losing the tracking costs a little polish on uppercase
 * Latin labels; keeping it costs unreadable Arabic.
 */
export const PDF_CAPTURE_CSS = `
  ${ARABIC_SAFE_CSS}
  @media screen {
    body { background: #ffffff !important; padding: 0 !important; }
    .print-sheet {
      margin: 0 !important;
      max-width: none !important;
      min-height: auto !important;
      box-shadow: none !important;
    }
  }
`;

const PRINT_BASE_CSS = `
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #0f172a;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  body {
    font-family: ${ARABIC_FONT_STACK};
    font-size: 12px;
    line-height: 1.45;
  }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  .no-print { display: none !important; }
  @page {
    size: A4;
    margin: 12mm;
  }
  @media print {
    html, body {
      width: 100%;
      height: auto;
      overflow: visible !important;
    }
    .no-print { display: none !important; }
    a[href]::after { content: none !important; }
  }
  @media screen {
    body {
      background: #e2e8f0;
      padding: 16px;
    }
    .print-sheet {
      margin: 0 auto;
      max-width: 210mm;
      min-height: 297mm;
      background: #fff;
      box-shadow: 0 8px 30px rgba(15, 23, 42, 0.12);
    }
  }
`;

const PRINT_WINDOW_FEATURES = "width=920,height=1100";

export interface PrintDocumentOptions {
  /** Document title (browser tab + suggested PDF name). */
  title?: string;
  /**
   * A window claimed by {@link openPlaceholderWindow} inside the user gesture;
   * it is navigated to the document instead of opening a new one.
   */
  target?: Window | null;
  /** Text direction. Default inferred from content / "rtl". */
  dir?: "rtl" | "ltr";
  /** Extra CSS appended after the base print stylesheet. */
  extraCss?: string;
  /** When true, call window.print() after images load. */
  autoPrint?: boolean;
  /**
   * Close the print window after the print dialog is dismissed.
   * Default true when autoPrint is true.
   */
  closeAfterPrint?: boolean;
}

/** Detect a full HTML document vs a body fragment. */
export function isFullHtmlDocument(html: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(html.trim());
}

/**
 * Inject full-page print CSS into an existing HTML document, or wrap a fragment
 * in a complete A4-ready document.
 */
export function toPrintableHtml(html: string, options: PrintDocumentOptions = {}): string {
  const title = options.title?.trim() || "Document";
  const dir = options.dir ?? (/dir\s*=\s*["']?rtl/i.test(html) ? "rtl" : "rtl");
  const styleBlock = `<style type="text/css">${PRINT_BASE_CSS}\n${options.extraCss ?? ""}</style>`;
  const trimmed = html.trim();

  if (isFullHtmlDocument(trimmed)) {
    let doc = trimmed;
    // Charset first (must land early in the head), then the CSP — both ahead of
    // the style block and body, which carry the untrusted values.
    const headInject = `${/<meta\s+charset=/i.test(doc) ? "" : `<meta charset="utf-8">`}${CSP_META}`;
    if (/<head([^>]*)>/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1>${headInject}`);
    } else if (/<html([^>]*)>/i.test(doc)) {
      doc = doc.replace(/<html([^>]*)>/i, `<html$1><head>${headInject}</head>`);
    } else {
      doc = headInject + doc;
    }
    if (/<\/head>/i.test(doc)) {
      doc = doc.replace(/<\/head>/i, `${styleBlock}</head>`);
    } else if (/<body/i.test(doc)) {
      doc = doc.replace(/<body/i, `${styleBlock}<body`);
    } else {
      doc = styleBlock + doc;
    }
    if (/<title>[\s\S]*?<\/title>/i.test(doc)) {
      doc = doc.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
    } else if (/<head([^>]*)>/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(title)}</title>`);
    }
    if (!/\sdir\s*=/i.test(doc.match(/<html[^>]*>/i)?.[0] ?? "")) {
      doc = doc.replace(/<html/i, `<html dir="${dir}"`);
    }
    return doc;
  }

  return `<!DOCTYPE html>
<html lang="${dir === "rtl" ? "ar" : "en"}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  ${CSP_META}
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${styleBlock}
</head>
<body>
  <div class="print-sheet">
    ${trimmed}
  </div>
</body>
</html>`;
}

function waitForImages(doc: Document): Promise<void> {
  const images = Array.from(doc.images);
  if (!images.length) return Promise.resolve();
  return Promise.all(
    images.map(
      (img) =>
        new Promise<void>((done) => {
          if (img.complete) {
            done();
            return;
          }
          img.addEventListener("load", () => done(), { once: true });
          img.addEventListener("error", () => done(), { once: true });
        }),
    ),
  ).then(() => undefined);
}

function waitForWindowReady(win: Window, navigating: boolean): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      void waitForImages(win.document).then(() => {
        // Let layout settle after images
        requestAnimationFrame(() => setTimeout(resolve, 80));
      });
    };
    // A placeholder's initial about:blank is already "complete"; trusting it
    // would print the blank page. The blob document's own load event is the
    // readiness signal there (the listener survives because the initial
    // about:blank Window is reused by the navigation).
    if (!navigating && win.document.readyState === "complete") {
      finish();
      return;
    }
    win.addEventListener("load", finish, { once: true });
    // Safety if load never fires (some blob navigations)
    setTimeout(finish, 2500);
  });
}

function createHtmlBlobUrl(html: string): string {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  return URL.createObjectURL(blob);
}

/**
 * Mount printable HTML in a hidden iframe for PDF capture. The frame is
 * same-origin so html2canvas can read it, but sandboxed so it cannot run script.
 */
async function mountHiddenIframe(html: string): Promise<{
  iframe: HTMLIFrameElement;
  cleanup: () => void;
}> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  // Must be set before the frame is attached and written to. Blocks scripts in
  // the untrusted document while keeping it readable by html2canvas.
  iframe.setAttribute("sandbox", PDF_FRAME_SANDBOX);
  iframe.title = "pdf-export";
  // A4-ish CSS px at 96dpi (~210mm x 297mm)
  iframe.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    "width:794px",
    "height:1123px",
    "border:0",
    "opacity:0",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    throw new Error("Could not create print frame.");
  }

  doc.open();
  doc.write(html);
  doc.close();

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    if (doc.readyState === "complete") {
      requestAnimationFrame(() => setTimeout(done, 50));
      return;
    }
    iframe.addEventListener("load", () => setTimeout(done, 50), { once: true });
    setTimeout(done, 2000);
  });
  await waitForImages(doc);
  // Extra paint time for fonts / layout
  await new Promise((r) => setTimeout(r, 100));

  return {
    iframe,
    cleanup: () => {
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * يحجز نافذة فارغة داخل إيماءة المستخدم، لتُملأ بالمستند بعد جلبه.
 *
 * Browsers honour `window.open` only inside a live user gesture, and Safari
 * spends the gesture on the first `await`. A document that needs a round trip
 * before it exists (the invoice breakdown RPC) must claim its window first and
 * navigate it once the HTML is ready. Null means the popup was blocked, so the
 * caller can stop before paying for the fetch.
 */
export function openPlaceholderWindow(): Window | null {
  return window.open("", "_blank", PRINT_WINDOW_FEATURES);
}

/**
 * Open HTML in a dedicated window for full-page preview / print.
 * Uses a Blob URL so content always renders (no blank about:blank tab).
 */
export async function openPrintableDocument(
  html: string,
  options: PrintDocumentOptions = {},
): Promise<Window | null> {
  const printable = toPrintableHtml(html, options);
  const url = createHtmlBlobUrl(printable);

  // Do not pass noopener — we need a usable Window reference for print().
  // Note: a blob: URL inherits the origin of the document that created it, so
  // this tab is same-origin with the app and `opener` stays reachable. Script
  // execution is prevented by the CSP that toPrintableHtml injects, not by the
  // blob URL itself.
  const placeholder = options.target && !options.target.closed ? options.target : null;
  const win = placeholder ?? window.open(url, "_blank", PRINT_WINDOW_FEATURES);
  if (!win) {
    URL.revokeObjectURL(url);
    return null;
  }
  if (placeholder) placeholder.location.replace(url);

  try {
    await waitForWindowReady(win, Boolean(placeholder));
  } catch {
    /* still try print / leave window open */
  }

  if (options.autoPrint) {
    const shouldClose = options.closeAfterPrint ?? true;
    const cleanup = () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      if (shouldClose) {
        try {
          win.close();
        } catch {
          /* ignore */
        }
      }
    };
    win.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(cleanup, 120_000);
    try {
      win.focus();
      win.print();
    } catch {
      // If print fails, leave the document visible for manual Ctrl+P
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    }
  } else {
    // Preview: keep content; free blob after a while
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 120_000);
  }

  return win;
}

export type LoadedDocumentOutcome = "opened" | "blocked" | "empty";

/**
 * يحجز النافذة أولًا، ثم يحمّل المستند، ثم يعرضه فيها.
 *
 * The gesture-safe order for any paper that is fetched on click: claim the
 * window synchronously, only then await the loader. A loader that throws or
 * returns null closes the claimed window so the operator is not left with a
 * blank tab; the throw is re-raised for the caller's own error toast.
 */
export async function openLoadedDocument(
  load: () => Promise<{
    html: string;
    title?: string;
    dir?: "rtl" | "ltr";
    extraCss?: string;
  } | null>,
  options: { autoPrint: boolean },
): Promise<LoadedDocumentOutcome> {
  const target = openPlaceholderWindow();
  if (!target) return "blocked";
  let built;
  try {
    built = await load();
  } catch (error) {
    target.close();
    throw error;
  }
  if (!built) {
    target.close();
    return "empty";
  }
  const win = await openPrintableDocument(built.html, {
    title: built.title,
    dir: built.dir,
    extraCss: built.extraCss,
    target,
    autoPrint: options.autoPrint,
  });
  return win ? "opened" : "blocked";
}

/** Open a full-page print dialog (user may choose printer or Save as PDF). */
export async function printHtmlDocument(
  html: string,
  options: Omit<PrintDocumentOptions, "autoPrint"> = {},
): Promise<boolean> {
  const win = await openPrintableDocument(html, { ...options, autoPrint: true });
  return Boolean(win);
}

/**
 * Generate a real PDF file from HTML and trigger a browser download.
 * Renders via a hidden iframe + html2canvas + jsPDF (A4 pages).
 */
export async function downloadHtmlAsPdf(
  html: string,
  filename: string,
  options: Omit<PrintDocumentOptions, "autoPrint" | "title"> & { title?: string } = {},
): Promise<boolean> {
  const baseName = filename.replace(/\.pdf$/i, "") || options.title || "document";
  const pdfName = `${baseName}.pdf`;
  const printable = toPrintableHtml(html, {
    ...options,
    title: options.title ?? baseName,
    // Caller CSS first so the capture-only overrides above always win.
    extraCss: `${options.extraCss ?? ""}\n${PDF_CAPTURE_CSS}`,
  });

  let mounted: { iframe: HTMLIFrameElement; cleanup: () => void } | null = null;
  try {
    mounted = await mountHiddenIframe(printable);
    const target =
      mounted.iframe.contentDocument?.body ?? mounted.iframe.contentDocument?.documentElement;
    if (!target) throw new Error("Print frame body missing.");

    // Loaded on demand — html2canvas + jsPDF are ~591 KB and only the PDF download
    // path needs them. Preview and print go through the browser's own renderer.
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);

    const canvas = await html2canvas(target, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#ffffff",
      logging: false,
      windowWidth: target.scrollWidth || 794,
      windowHeight: target.scrollHeight || 1123,
    });

    const imgData = canvas.toDataURL("image/png", 1.0);
    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
      compress: true,
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    // Fit short invoices on one page; multi-page for long reports
    if (imgHeight <= pageHeight + 0.5) {
      pdf.addImage(imgData, "PNG", 0, 0, imgWidth, imgHeight, undefined, "FAST");
    } else {
      let heightLeft = imgHeight;
      let y = 0;
      pdf.addImage(imgData, "PNG", 0, y, imgWidth, imgHeight, undefined, "FAST");
      heightLeft -= pageHeight;
      while (heightLeft > 1) {
        y = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, y, imgWidth, imgHeight, undefined, "FAST");
        heightLeft -= pageHeight;
      }
    }

    pdf.save(pdfName);
    return true;
  } catch (error) {
    console.error("[downloadHtmlAsPdf]", error);
    // Fallback: open printable HTML tab so user can still Save as PDF
    const win = await openPrintableDocument(html, {
      ...options,
      title: baseName,
      autoPrint: true,
      closeAfterPrint: false,
    });
    return Boolean(win);
  } finally {
    mounted?.cleanup();
  }
}
