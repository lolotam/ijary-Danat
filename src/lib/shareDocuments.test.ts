import { describe, expect, test } from "vitest";

import { buildMailtoUrl, buildWhatsAppUrl, type DocLink } from "@/lib/shareDocuments";

const labels = {
  intro: "مستندات من دانة المستقبل العقارية:",
  expiryNote: "(تنتهي الروابط خلال 5 دقائق.)",
};
const links: DocLink[] = [
  { name: "Civil ID.pdf", url: "https://storage.example/civil-id?token=abc" },
  { name: "Contract.pdf", url: "https://storage.example/contract?token=def" },
];

const KUWAIT_PHONE_ERROR = "Invalid Kuwait phone — use +965 8 digits or 8 digits only";

describe("buildWhatsAppUrl", () => {
  test("strips formatting and the leading + from a +965 number", () => {
    const url = buildWhatsAppUrl("+965 1234-5678", links, labels);

    expect(url.startsWith("https://wa.me/96512345678?")).toBe(true);
  });

  test("prepends 965 to a bare 8-digit local number", () => {
    const url = buildWhatsAppUrl("12345678", links, labels);

    expect(url.startsWith("https://wa.me/96512345678?")).toBe(true);
  });

  test("accepts digits already including the 965 country code", () => {
    const url = buildWhatsAppUrl("96512345678", links, labels);

    expect(url.startsWith("https://wa.me/96512345678?")).toBe(true);
  });

  test("carries every document link in the message text", () => {
    const text = new URL(buildWhatsAppUrl("96512345678", links, labels)).searchParams.get("text");

    expect(text).toContain("https://storage.example/civil-id?token=abc");
    expect(text).toContain("https://storage.example/contract?token=def");
  });

  test("uses the caller-supplied locale copy rather than English defaults", () => {
    const text = new URL(buildWhatsAppUrl("96512345678", links, labels)).searchParams.get("text");

    expect(text).toContain(labels.intro);
    expect(text).toContain(labels.expiryNote);
  });

  test.each([
    ["+971501234567", "UAE country code"],
    ["1234567", "too few digits"],
    ["1234567890", "too many digits without 965"],
  ])("rejects %s (%s)", (phone) => {
    expect(() => buildWhatsAppUrl(phone, links, labels)).toThrow(KUWAIT_PHONE_ERROR);
  });
});

describe("buildMailtoUrl", () => {
  test("encodes the subject and the document links into the body", () => {
    const url = buildMailtoUrl("tenant@example.com", "Your documents", links, labels);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));

    expect(url.startsWith("mailto:tenant@example.com?")).toBe(true);
    expect(params.get("subject")).toBe("Your documents");
    expect(params.get("body")).toContain("https://storage.example/contract?token=def");
  });
});
