import { accessSync, constants } from "node:fs";
import { describe, expect, it, test } from "vitest";

import { buildChromiumPdfArgs, renderHtmlToPdf, wrapHtmlForPdf } from "./serverPdf";

/**
 * Chromium is present in the production image, not on every developer or CI
 * host. Rendering cases need a real binary — mocks would not prove the path
 * this module exists to deliver. Skip those when no binary is found.
 *
 * ARABIC VISUAL CORRECTNESS IS NOT PROVEN BY THESE TESTS. Shaping and bidi are
 * verified by the orchestrator against a built image, not by assertions here.
 */

function probeChromiumPath(): string | null {
  const env = process.env.CHROMIUM_PATH?.trim();
  if (env) {
    try {
      accessSync(env, constants.F_OK);
      return env;
    } catch {
      return null;
    }
  }

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const path of candidates) {
    try {
      accessSync(path, constants.F_OK);
      return path;
    } catch {
      // try next
    }
  }
  return null;
}

const chromiumPath = probeChromiumPath();
const hasChromium = chromiumPath !== null;
const skipReason = "Chromium binary not found (set CHROMIUM_PATH or install Chromium/Chrome)";

describe("wrapHtmlForPdf", () => {
  it("emits dir=rtl and lang=ar when Arabic is requested", () => {
    const out = wrapHtmlForPdf("<p>مرحبا</p>", { arabic: true });
    expect(out).toMatch(/dir=["']rtl["']/i);
    expect(out).toMatch(/lang=["']ar["']/i);
  });

  it("emits dir=ltr and lang=en when Arabic is not requested", () => {
    const out = wrapHtmlForPdf("<p>Hello</p>", { arabic: false });
    expect(out).toMatch(/dir=["']ltr["']/i);
    expect(out).toMatch(/lang=["']en["']/i);
  });

  it("defaults to ltr/en when options are omitted", () => {
    const out = wrapHtmlForPdf("<p>Hello</p>");
    expect(out).toMatch(/dir=["']ltr["']/i);
    expect(out).toMatch(/lang=["']en["']/i);
  });

  it("includes the letter-spacing reset that protects Arabic joining", () => {
    const out = wrapHtmlForPdf("<p>x</p>", { arabic: true });
    expect(out).toMatch(/letter-spacing:\s*normal\s*!important/);
    expect(out).toMatch(/\*[^{]*\{[^}]*letter-spacing:\s*normal\s*!important/);
  });

  it("includes the Arabic-capable font stack naming installed families", () => {
    const out = wrapHtmlForPdf("<p>x</p>", { arabic: true });
    expect(out).toContain("Noto Naskh Arabic");
    expect(out).toContain("DejaVu Sans");
  });

  it("passes a full <!doctype>/<html> document through unwrapped", () => {
    const full = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>T</title></head><body><p>already full</p></body></html>`;
    const out = wrapHtmlForPdf(full, { arabic: true });
    expect(out).toBe(full.trim());
    // Must not double-wrap
    expect(out.match(/<!doctype/gi)?.length ?? 0).toBe(1);
    expect(out.match(/<html[\s>]/gi)?.length ?? 0).toBe(1);
  });

  it("passes a full uppercase DOCTYPE document through unwrapped", () => {
    const full = `<!DOCTYPE html><html><head></head><body>x</body></html>`;
    expect(wrapHtmlForPdf(full)).toBe(full.trim());
  });
});

describe("buildChromiumPdfArgs", () => {
  it("includes --no-sandbox and --disable-dev-shm-usage", () => {
    const args = buildChromiumPdfArgs("/tmp/in.html", "/tmp/out.pdf");
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-dev-shm-usage");
  });

  it("includes headless, print-to-pdf, and header/footer suppression", () => {
    const args = buildChromiumPdfArgs("/tmp/in.html", "/tmp/out.pdf");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-gpu");
    expect(args.some((a) => a.startsWith("--print-to-pdf="))).toBe(true);
    expect(args).toContain("--no-pdf-header-footer");
  });

  it("points print-to-pdf at the output path and ends with the input path", () => {
    const args = buildChromiumPdfArgs("/tmp/in.html", "/tmp/out.pdf");
    expect(args).toContain("--print-to-pdf=/tmp/out.pdf");
    expect(args[args.length - 1]).toBe("/tmp/in.html");
  });
});

describe.skipIf(!hasChromium)("renderHtmlToPdf (requires Chromium)", () => {
  // Point the renderer at the probed binary when the env var is unset.
  if (chromiumPath && !process.env.CHROMIUM_PATH) {
    process.env.CHROMIUM_PATH = chromiumPath;
  }

  /**
   * يشغّل Chromium ويعيد المحاولة عند فشل التشغيل نفسه فقط.
   *
   * Deliberately NOT vitest's `retry`, which re-runs the assertions too and
   * would hide a genuine intermittent break in the renderer — a PDF that is
   * occasionally malformed would be retried into a pass. Only a THROW from
   * `renderHtmlToPdf` is retried; whatever it eventually returns is asserted
   * exactly once, below.
   *
   * This is the only test in the suite that spawns a real browser, and under a
   * machine already running 234 other test files the spawn itself intermittently
   * fails. Alone it takes about two seconds.
   */
  async function renderWithSpawnRetry(html: string, attempts = 3): Promise<Buffer> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await renderHtmlToPdf(html);
      } catch (error) {
        if (attempt >= attempts) throw error;
      }
    }
  }

  // 120s rather than 30s: the budget now has to cover up to three cold Chromium
  // starts on a loaded machine, and 30s was not reliably enough for even one.
  it("returns a Buffer starting with %PDF- for trivial HTML", { timeout: 120_000 }, async () => {
    const pdf = await renderWithSpawnRetry(wrapHtmlForPdf("<p>Hello PDF</p>"));

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it("rejects a deliberately broken invocation with Error, not Response", async () => {
    const prev = process.env.CHROMIUM_PATH;
    // Non-existent binary → spawn ENOENT or non-zero exit → typed Error.
    process.env.CHROMIUM_PATH = joinBrokenPath();
    try {
      await expect(renderHtmlToPdf("<p>x</p>")).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(Response);
        return true;
      });
    } finally {
      if (prev === undefined) {
        delete process.env.CHROMIUM_PATH;
      } else {
        process.env.CHROMIUM_PATH = prev;
      }
    }
  });
});

/** Path that cannot be a Chromium binary — forces spawn/start failure. */
function joinBrokenPath(): string {
  return process.platform === "win32"
    ? "C:\\nonexistent\\danat-chromium-missing.exe"
    : "/tmp/danat-chromium-missing-binary";
}

// Document the skip when binary is absent so the suite output is self-explanatory.
if (!hasChromium) {
  describe("renderHtmlToPdf (skipped — no Chromium)", () => {
    test.skip(skipReason, () => {
      // placeholder — skip reason surfaces in the reporter
    });
  });
}
