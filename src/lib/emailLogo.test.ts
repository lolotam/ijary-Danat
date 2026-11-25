import { describe, expect, it } from "vitest";

import { EMAIL_LOGO_MARKER, applyEmailLogo } from "./emailLogo";

describe("applyEmailLogo", () => {
  it("replaces the marker with an img", () => {
    const html = `<td>${EMAIL_LOGO_MARKER}<div>Brand</div></td>`;
    const out = applyEmailLogo(html, "https://example.test/logo.png", "Danat");

    expect(out).toContain('src="https://example.test/logo.png"');
    expect(out).toContain('alt="Danat"');
    expect(out).not.toContain(EMAIL_LOGO_MARKER);
    expect(out).toContain("<div>Brand</div>");
  });

  it("removes the marker when there is no logo", () => {
    const html = `<td>${EMAIL_LOGO_MARKER}<div>Brand</div></td>`;
    const out = applyEmailLogo(html, null, "Danat");

    expect(out).not.toContain(EMAIL_LOGO_MARKER);
    expect(out).not.toContain("<img");
    expect(out).toContain("<div>Brand</div>");
  });

  it("treats an empty or blank url as no logo", () => {
    expect(applyEmailLogo(`x${EMAIL_LOGO_MARKER}y`, "", "Danat")).not.toContain("<img");
    expect(applyEmailLogo(`x${EMAIL_LOGO_MARKER}y`, "   ", "Danat")).not.toContain("<img");
  });

  it("leaves a document with no marker untouched", () => {
    const html = "<!doctype html><html><body>Raw</body></html>";
    expect(applyEmailLogo(html, "https://example.test/l.png", "Danat")).toBe(html);
  });

  it("escapes the url and the alt text", () => {
    const out = applyEmailLogo(
      `x${EMAIL_LOGO_MARKER}y`,
      'https://e.test/a.png"onerror="alert(1)',
      '"><script>alert(1)</script>',
    );

    expect(out).not.toContain("<script>");
    expect(out).not.toContain('onerror="alert(1)"');
  });

  it("replaces every marker, not only the first", () => {
    // String.replace with a string pattern replaces one occurrence; a body that
    // somehow carried two would keep the second forever.
    const out = applyEmailLogo(`${EMAIL_LOGO_MARKER}|${EMAIL_LOGO_MARKER}`, null, "Danat");
    expect(out).not.toContain(EMAIL_LOGO_MARKER);
  });

  it("does not interpret $ sequences in the url as replacement patterns", () => {
    const out = applyEmailLogo(`x${EMAIL_LOGO_MARKER}y`, "https://e.test/$&$1.png", "Danat");
    expect(out).toContain("https://e.test/$&amp;$1.png");
  });

  it("is a no-op when applied twice", () => {
    // dispatchNotification applies it, and a drain-job resend of the stored body
    // may apply it again. The second pass must not double the logo.
    const once = applyEmailLogo(`x${EMAIL_LOGO_MARKER}y`, "https://e.test/l.png", "Danat");
    expect(applyEmailLogo(once, "https://e.test/l.png", "Danat")).toBe(once);
  });
});
