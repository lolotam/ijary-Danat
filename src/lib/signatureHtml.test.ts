import { describe, expect, it } from "vitest";

import {
  buildSignatureHtml,
  EMPTY_SIGNATURE_DETAILS,
  markSignatureBlock,
  applySignatureToBody,
  SIGNATURE_BLOCK_ATTR,
  type SignatureDetails,
} from "@/lib/signatureHtml";

/** يبني حقول توقيع باسم صالح مع تعديلات الاختبار. */
const details = (overrides: Partial<SignatureDetails> = {}): SignatureDetails => ({
  ...EMPTY_SIGNATURE_DETAILS,
  fullName: "Waleed Mohamed",
  ...overrides,
});

describe("buildSignatureHtml", () => {
  it("omits every field that was left blank", () => {
    const html = buildSignatureHtml(details());

    expect(html).toContain("Waleed Mohamed");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("|");
    expect(html).not.toContain("<a ");
  });

  it("separates phone and email only when both are present", () => {
    // A lone separator reads as a missing value rather than an absent field.
    expect(buildSignatureHtml(details({ phone: "+965 5000 0000" }))).not.toContain(" | ");
    expect(
      buildSignatureHtml(details({ phone: "+965 5000 0000", email: "w@example.com" })),
    ).toContain("+965 5000 0000 | w@example.com");
  });

  it("escapes field values so a name cannot inject markup", () => {
    // This HTML is stored and later rendered into a privileged admin session, so
    // an unescaped value is stored XSS rather than a rendering bug.
    const html = buildSignatureHtml(details({ fullName: "<script>alert(1)</script>" }));

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("refuses a javascript: website rather than emitting a live href", () => {
    // Flagged by a security review, 2026-08-13. escapeHtml stops a value
    // breaking OUT of the attribute; it does nothing about what the attribute
    // then means. "javascript:alert(1)" contains none of the escaped characters,
    // so it survived intact and became a live href that runs in the next
    // admin's privileged session when they click the signature.
    const html = buildSignatureHtml(details({ website: "javascript:alert(1)" }));

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
  });

  it.each([
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    " JavaScript:alert(1)",
  ])("refuses the hostile scheme %s", (website) => {
    expect(buildSignatureHtml(details({ website }))).not.toContain("<a ");
  });

  it("keeps http, https and mailto links", () => {
    expect(buildSignatureHtml(details({ website: "https://danat-future.com" }))).toContain(
      'href="https://danat-future.com"',
    );
    expect(buildSignatureHtml(details({ website: "mailto:info@danat-future.com" }))).toContain(
      'href="mailto:info@danat-future.com"',
    );
  });

  it("upgrades a bare domain to https rather than dropping it", () => {
    // Admins type "danat-future.com". Silently losing their website is worse
    // than assuming the scheme they obviously meant.
    const html = buildSignatureHtml(details({ website: "danat-future.com" }));

    expect(html).toContain('href="https://danat-future.com"');
    expect(html).toContain(">danat-future.com<");
  });

  it("drops a logo whose URL is not an image the recipient can load", () => {
    // An <img src> is a weaker vector than an href in current browsers, but the
    // stored HTML is emailed and previewed elsewhere; a scheme allow-list costs
    // nothing.
    expect(buildSignatureHtml(details({ logoUrl: "javascript:alert(1)" }))).not.toContain("<img");
    expect(buildSignatureHtml(details({ logoUrl: '" onerror="alert(1)' }))).not.toContain("<img");
    expect(buildSignatureHtml(details({ logoUrl: "https://x/logo.png" }))).toContain("<img");
  });

  it("renders the logo cell and a divider only when a logo is set", () => {
    expect(buildSignatureHtml(details())).not.toContain("border-inline-start");
    expect(buildSignatureHtml(details({ logoUrl: "https://x/logo.png" }))).toContain(
      "border-inline-start",
    );
  });

  it("uses logical properties so the layout mirrors under Arabic", () => {
    // The signature sits under Arabic at least as often as under English; a
    // hard-coded padding-right would put the divider on the wrong side there.
    const html = buildSignatureHtml(details({ logoUrl: "https://x/logo.png" }));

    expect(html).toContain("padding-inline-end");
    expect(html).not.toContain("padding-right");
  });

  it("renders nothing at all for wholly empty details", () => {
    // Lets callers treat "no signature" and "an empty signature" identically.
    expect(buildSignatureHtml(EMPTY_SIGNATURE_DETAILS)).toBe("");
  });

  it("renders a logo-only signature", () => {
    const html = buildSignatureHtml({ ...EMPTY_SIGNATURE_DETAILS, logoUrl: "https://x/logo.png" });

    expect(html).toContain("<img");
    expect(html).not.toBe("");
  });
});

describe("markSignatureBlock", () => {
  it("returns nothing for an empty signature so no stray divider is added", () => {
    expect(markSignatureBlock("")).toBe("");
  });

  it("adds a top divider above the signature", () => {
    expect(markSignatureBlock("<table></table>")).toContain("border-top");
  });

  it("marks the signature's own table, because the editor schema drops a wrapping div", () => {
    const marked = markSignatureBlock('<table style="font-family:Arial;"><tr></tr></table>');
    expect(marked).toContain(`${SIGNATURE_BLOCK_ATTR}="1"`);
    // One table, not a marked wrapper around an unmarked one.
    expect(marked.match(/<table/g) ?? []).toHaveLength(1);
  });

  it("keeps the table's existing styling when adding the divider", () => {
    const marked = markSignatureBlock('<table style="font-family:Arial;"></table>');
    expect(marked).toContain("font-family:Arial;");
    expect(marked).toContain("border-top");
  });

  it("wraps a signature that is not a table so it stays replaceable", () => {
    const marked = markSignatureBlock("<p>Waleed</p>");
    expect(marked).toContain(`${SIGNATURE_BLOCK_ATTR}="1"`);
    expect(marked).toContain("<p>Waleed</p>");
  });
});

describe("applySignatureToBody", () => {
  const first = markSignatureBlock('<table style="a"><tr><td>First</td></tr></table>');
  const second = '<table style="b"><tr><td>Second</td></tr></table>';

  it("appends the signature to the body", () => {
    const body = applySignatureToBody("<p>Hello</p>", "<table><tr><td>Sig</td></tr></table>");
    expect(body).toContain("<p>Hello</p>");
    expect(body).toContain("Sig");
  });

  it("replaces an existing signature instead of stacking a second", () => {
    const body = applySignatureToBody(`<p>Hello</p>${first}`, second);
    expect(body).toContain("Second");
    expect(body).not.toContain("First");
    expect(body.match(new RegExp(SIGNATURE_BLOCK_ATTR, "g")) ?? []).toHaveLength(1);
  });

  it("removes the signature when none is selected", () => {
    expect(applySignatureToBody(`<p>Hello</p>${first}`, "")).toBe("<p>Hello</p>");
  });

  it("leaves a table the admin pasted alone", () => {
    const pasted = "<table><tr><td>Rent schedule</td></tr></table>";
    const body = applySignatureToBody(`<p>Hi</p>${pasted}${first}`, second);
    expect(body).toContain("Rent schedule");
    expect(body).not.toContain("First");
  });

  it("keeps the body unchanged when there is nothing to strip or add", () => {
    expect(applySignatureToBody("<p>Hello</p>", "")).toBe("<p>Hello</p>");
  });

  it("removes a wrapped signature whole when it contains its own table", () => {
    // Raised in review of PR #138. A signature stored as something other than a
    // table gets a table wrapper, and matching to the *first* closing tag then
    // stopped inside it — leaving a stray </table> that corrupted the body on
    // the next selection.
    const nested = markSignatureBlock("<div><table><tr><td>Hours</td></tr></table></div>");

    expect(applySignatureToBody(`<p>Hi</p>${nested}`, "")).toBe("<p>Hi</p>");
  });

  it("replaces a wrapped signature containing a table without leaving debris", () => {
    const nested = markSignatureBlock("<div><table><tr><td>Hours</td></tr></table></div>");
    const body = applySignatureToBody(`<p>Hi</p>${nested}`, second);

    expect(body).toContain("Second");
    expect(body).not.toContain("Hours");
    expect(body.match(/<table/g) ?? []).toHaveLength(1);
  });

  it("leaves a body whose signature table was never closed alone", () => {
    // Already malformed. Stripping to the end of the string would take the
    // admin's own text with it.
    const broken = `<p>Hi</p><table ${SIGNATURE_BLOCK_ATTR}="1"><tr><td>x`;

    expect(applySignatureToBody(broken, "")).toBe(broken);
  });
});
