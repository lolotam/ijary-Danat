/**
 * @vitest-environment jsdom
 *
 * DOMPurify needs a `window`, and this suite's default environment is `node`.
 * jsdom is a dev dependency for exactly this file — pulling it into the runtime
 * via isomorphic-dompurify would guard a server-side surface the app does not
 * have.
 */
import { describe, expect, it } from "vitest";

import { sanitizeSignatureHtml } from "@/lib/sanitizeHtml";

describe("sanitizeSignatureHtml", () => {
  it("removes script elements", () => {
    expect(sanitizeSignatureHtml("<p>Hi</p><script>alert(1)</script>")).toBe("<p>Hi</p>");
  });

  it("removes inline event handlers", () => {
    // The attribute survives naive escaping — only an allow-list drops it.
    const clean = sanitizeSignatureHtml('<img src="https://x/a.png" onerror="alert(1)" />');

    expect(clean).not.toContain("onerror");
    expect(clean).toContain("https://x/a.png");
  });

  it("removes javascript: hrefs", () => {
    expect(sanitizeSignatureHtml('<a href="javascript:alert(1)">x</a>')).not.toContain(
      "javascript:",
    );
  });

  it("keeps the inline styles a signature depends on", () => {
    // Mail clients strip <style> blocks, so a signature is inline styles or it
    // is nothing. Dropping them here would silently flatten every signature.
    const clean = sanitizeSignatureHtml(
      '<table><tr><td style="vertical-align:top;">x</td></tr></table>',
    );

    expect(clean).toContain("vertical-align:top");
  });

  it("keeps the table and image structure a signature is built from", () => {
    const clean = sanitizeSignatureHtml(
      '<table><tr><td><img src="https://x/logo.png" width="80" /></td></tr></table>',
    );

    expect(clean).toContain("<table");
    expect(clean).toContain("<img");
  });

  it("keeps a dir attribute so an Arabic signature stays right-to-left", () => {
    // Regression, 2026-08-13. ALLOWED_URI_REGEXP is not scoped to URI
    // attributes — DOMPurify tests it against the value of every attribute not
    // declared URI-safe. The strict scheme pattern was therefore run against
    // dir="rtl", style="…" and width="80", none of which are URLs, and dropped
    // all three. This assertion is the cheap proxy for that whole class.
    expect(sanitizeSignatureHtml('<div dir="rtl">مرحبا</div>')).toContain('dir="rtl"');
  });

  it("keeps the sizing attributes a logo needs", () => {
    // Same root cause as the dir case above, and the one that actually mattered:
    // a logo stripped of width renders full-size in the recipient's inbox.
    const clean = sanitizeSignatureHtml('<img src="https://x/logo.png" width="80" alt="" />');

    expect(clean).toContain('width="80"');
  });

  it("allows an inline base64 logo but not an arbitrary data URI", () => {
    const image = sanitizeSignatureHtml('<img src="data:image/png;base64,iVBORw0KGgo=" />');
    const html = sanitizeSignatureHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>');

    expect(image).toContain("data:image/png");
    expect(html).not.toContain("data:text/html");
  });
});
