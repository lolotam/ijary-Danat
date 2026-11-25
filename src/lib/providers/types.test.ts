import { describe, expect, it } from "vitest";

import { toInternationalDigits } from "./types";

describe("toInternationalDigits", () => {
  it.each([
    { stored: "55433488", delivered: "96555433488" },
    { stored: "66399093", delivered: "96566399093" },
    { stored: "97550232", delivered: "96597550232" },
    { stored: "5012-3456", delivered: "96550123456" },
  ])("defaults the bare Kuwaiti mobile $stored to 965", ({ stored, delivered }) => {
    // Regression, 2026-09-01: tenants' numbers are stored as bare 8-digit
    // locals, and refusing them silently failed every WhatsApp leg — the KNET
    // link send and the user-credentials automation both died on this.
    expect(toInternationalDigits(stored)).toBe(delivered);
  });

  it("keeps an already-international number untouched", () => {
    expect(toInternationalDigits("+965 5012 3456")).toBe("96550123456");
    expect(toInternationalDigits("+201001234567")).toBe("201001234567");
  });

  it("does not double the prefix when 965 is already there", () => {
    expect(toInternationalDigits("96555433488")).toBe("96555433488");
  });

  it.each(["1234567", "23456789", "0"])(
    "still refuses %s — no Kuwaiti mobile shape, no guessing",
    (stored) => {
      // 8 digits starting with 2 is a landline pattern, and short fragments
      // could belong to any country; assuming 965 would misdeliver.
      expect(() => toInternationalDigits(stored)).toThrow(/international format/i);
    },
  );

  it("refuses an empty recipient", () => {
    expect(() => toInternationalDigits("  ")).toThrow(/empty/i);
  });
});
