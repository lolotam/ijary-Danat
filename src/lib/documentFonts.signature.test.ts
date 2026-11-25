/**
 * @vitest-environment jsdom
 *
 * يبقى خط التوقيع كما هو بعد التنقية.
 *
 * The signature is sanitised on write AND on render, and DOMPurify needs a
 * window, hence jsdom. EMAIL_FONT_STACK carries quoted family names; if the
 * sanitiser dropped a style containing quotes, every saved signature would
 * silently lose its font the moment it was stored.
 */
import { describe, expect, it } from "vitest";

import { sanitizeSignatureHtml } from "@/lib/sanitizeHtml";
import { buildSignatureHtml, EMPTY_SIGNATURE_DETAILS } from "@/lib/signatureHtml";

describe("the signature font stack survives sanitisation", () => {
  it("keeps the quoted Arabic face on a stored signature", () => {
    const html = buildSignatureHtml({ ...EMPTY_SIGNATURE_DETAILS, fullName: "وليد" });
    expect(sanitizeSignatureHtml(html)).toContain("Noto Sans Arabic");
  });
});
