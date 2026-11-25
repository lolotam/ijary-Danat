/**
 * Server-side HTML → PDF renderer via headless Chromium.
 *
 * Shells out to the system Chromium binary. Do NOT replace this with
 * puppeteer or playwright:
 *
 * 1. This app runs on Bun. puppeteer's Node compatibility under Bun is a real
 *    risk, and this path is intended for unattended cron — a subtle failure
 *    there is invisible.
 * 2. Content is static HTML with no scripts, so nothing needs a CDP session,
 *    navigation waits, or DOM interaction.
 * 3. puppeteer would also download its own ~300 MB Chromium on install, on top
 *    of the apt-installed one already in the runtime image.
 *
 * Arabic correctness depends on Chromium's text engine PLUS fonts in the image
 * (fonts-noto-core / fonts-dejavu-core). Without those fonts Chromium shapes
 * correctly and then draws tofu boxes — a silent failure that looks like a
 * Chromium bug. The letter-spacing reset below is load-bearing for the same
 * reason as PDF_CAPTURE_CSS in printDocument.ts: non-zero letter-spacing breaks
 * Arabic glyph joining in rasterised / print output.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ARABIC_SAFE_CSS, CAIRO_PUBLIC_FONTS_BASE, PDF_FONT_STACK } from "@/lib/documentFonts";

const DEFAULT_CHROMIUM_PATH = "/usr/bin/chromium";
const RENDER_TIMEOUT_MS = 30_000;

/**
 * أساس CSS لملفات PDF الخادم: قاعدة حماية العربية، ثم الصفحة والخط.
 *
 * ARABIC_SAFE_CSS comes first and is the same rule PDF_CAPTURE_CSS uses in the
 * browser — see its note in documentFonts.ts for why it is load-bearing.
 */
const SERVER_PDF_BASE_CSS = `
  ${ARABIC_SAFE_CSS}
  * { box-sizing: border-box; }
  @page { size: A4; margin: 12mm; }
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #0f172a;
    font-family: ${PDF_FONT_STACK};
    font-size: 12px;
    line-height: 1.45;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
`;

export type WrapHtmlForPdfOptions = {
  /** When true, document is RTL Arabic; otherwise LTR English. */
  arabic?: boolean;
};

/** True when the input is already a complete HTML document. */
function isFullHtmlDocument(html: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(html.trim());
}

/**
 * يحلّ دليل خطوط public/fonts إلى رابط file:// مطلق يفهمه Chromium من ملف مؤقت.
 *
 * The server renders HTML from a temp file, so the browser-facing `/fonts`
 * prefix cannot resolve (decision D6). `.output/public/fonts` is the layout
 * the production image ships (the Dockerfile copies `.output`); `public/fonts`
 * is the dev checkout. When neither exists the public prefix is returned
 * unchanged, which degrades to the image's Noto faces instead of failing the
 * render — a missing display font must never cost a tenant their PDF.
 */
export function resolveServerFontsBaseUrl(): string {
  const candidates = [
    join(process.cwd(), ".output", "public", "fonts"),
    join(process.cwd(), "public", "fonts"),
  ];
  const fontsDir = candidates.find((dir) => existsSync(dir));
  return fontsDir ? pathToFileURL(fontsDir).href : CAIRO_PUBLIC_FONTS_BASE;
}

/**
 * يستبدل روابط خط Cairo العامة برابط file:// المطلق لدليل خطوط الخادم.
 *
 * Only the exact `url("/fonts/…")` prefix emitted by `cairoFontFace` is
 * rewritten, so receipts and reports that never reference the vendored fonts
 * pass through byte-identical. Appending a second @font-face instead (and
 * relying on last-rule-wins) was rejected: cascade order is a subtler
 * guarantee than a deterministic rewrite, and it would push a Cairo face into
 * documents that never asked for it.
 */
export function rebaseCairoFontUrls(html: string): string {
  const baseUrl = resolveServerFontsBaseUrl();
  if (baseUrl === CAIRO_PUBLIC_FONTS_BASE) {
    return html;
  }
  return html.replaceAll(`url("${CAIRO_PUBLIC_FONTS_BASE}/`, `url("${baseUrl}/`);
}

/**
 * Wrap a body fragment in a complete, Arabic-ready HTML document.
 * Full `<!doctype` / `<html` documents are returned verbatim (trimmed) so
 * admin-edited template bodies that already ship a full document are not
 * double-wrapped — same convention as loadTemplateCopy elsewhere.
 */
export function wrapHtmlForPdf(html: string, options: WrapHtmlForPdfOptions = {}): string {
  const raw = html.trim();
  if (isFullHtmlDocument(raw)) {
    return raw;
  }
  const trimmed = rebaseCairoFontUrls(raw);

  const arabic = options.arabic === true;
  const dir = arabic ? "rtl" : "ltr";
  const lang = arabic ? "ar" : "en";

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <style type="text/css">${SERVER_PDF_BASE_CSS}</style>
</head>
<body>
${trimmed}
</body>
</html>`;
}

/**
 * Resolve the Chromium binary. Prefers CHROMIUM_PATH so a macOS/Windows
 * developer can point at their own Chrome; falls back to the Debian package
 * path used in the runtime image.
 */
export function resolveChromiumPath(): string {
  const fromEnv = process.env.CHROMIUM_PATH?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CHROMIUM_PATH;
}

/**
 * Build the argv Chromium receives for a headless print-to-pdf run.
 * Exported so tests can assert required container-safety flags without
 * mocking the binary.
 */
export function buildChromiumPdfArgs(htmlPath: string, pdfPath: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    // Containers here have no user namespace; without this Chromium refuses to start.
    "--no-sandbox",
    // Docker's /dev/shm defaults to 64 MB; Chromium crashes on real content without this.
    "--disable-dev-shm-usage",
    // Suppress date/URL header and footer. Current Chromium name (formerly
    // --print-to-pdf-no-header). Verified against Chrome headless on Windows;
    // Debian trixie's chromium package uses the same flag family.
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    htmlPath,
  ];
}

function runChromium(
  chromiumPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{
  code: number | null;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(chromiumPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Chromium PDF render timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start Chromium at "${chromiumPath}": ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * Render HTML to a PDF Buffer using the system Chromium binary.
 * Writes temp files under the OS temp directory (never assumes a writable CWD)
 * and always cleans them up in `finally`.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const chromiumPath = resolveChromiumPath();
  const workDir = await mkdtemp(join(tmpdir(), "server-pdf-"));
  const htmlPath = join(workDir, "input.html");
  const pdfPath = join(workDir, "output.pdf");

  try {
    await writeFile(htmlPath, html, "utf8");

    const args = buildChromiumPdfArgs(htmlPath, pdfPath);
    const { code, stderr } = await runChromium(chromiumPath, args, RENDER_TIMEOUT_MS);

    if (code !== 0) {
      const detail = stderr.trim() || "(no stderr)";
      throw new Error(
        `Chromium PDF render failed (exit ${code}) using "${chromiumPath}": ${detail}`,
      );
    }

    try {
      return await readFile(pdfPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const stderrNote = stderr.trim() ? ` stderr: ${stderr.trim()}` : "";
      throw new Error(
        `Chromium exited 0 but PDF was not written at "${pdfPath}": ${detail}.${stderrNote}`,
        { cause: err },
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
