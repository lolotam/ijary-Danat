import { describe, expect, test } from "vitest";

import {
  parseWhatsappSessionHealth,
  whatsappSessionBannerState,
  type WhatsappSessionHealth,
} from "./whatsappSessionBanner";

function health(overrides: Partial<WhatsappSessionHealth> = {}): WhatsappSessionHealth {
  return {
    enabled: true,
    paired: true,
    state: "close",
    settling: false,
    disconnected_at: "2026-11-11T07:10:00Z",
    parked_count: 0,
    ...overrides,
  };
}

describe("whatsappSessionBannerState", () => {
  test("returns hidden when health is missing (loading, error, or non-staff)", () => {
    expect(whatsappSessionBannerState(null)).toBe("hidden");
    expect(whatsappSessionBannerState(undefined)).toBe("hidden");
  });

  test("returns hidden when provider is disabled", () => {
    expect(whatsappSessionBannerState(health({ enabled: false }))).toBe("hidden");
  });

  test("returns hidden when state is open", () => {
    expect(whatsappSessionBannerState(health({ state: "open" }))).toBe("hidden");
  });

  test("returns hidden while settling", () => {
    expect(whatsappSessionBannerState(health({ state: "connecting", settling: true }))).toBe(
      "hidden",
    );
  });

  test("returns never_paired when enabled, not open, not settling, and paired is false", () => {
    expect(whatsappSessionBannerState(health({ paired: false, state: null }))).toBe("never_paired");
  });

  test.each([
    ["close", { state: "close" }],
    ["refused", { state: "refused" }],
    ["close with null disconnected_at", { state: "close", disconnected_at: null }],
  ] as const)("returns disconnected for %s when paired", (_label, overrides) => {
    expect(whatsappSessionBannerState(health(overrides))).toBe("disconnected");
  });
});

describe("parseWhatsappSessionHealth", () => {
  test("accepts a valid server health snapshot", () => {
    const valid = health({ parked_count: 12 });
    expect(parseWhatsappSessionHealth(valid)).toEqual(valid);
  });

  test.each([
    ["null", null],
    ["array", []],
    ["missing required fields", { enabled: true }],
    ["NaN parked_count", { ...health(), parked_count: Number.NaN }],
  ] as const)("rejects %s", (_label, malformed) => {
    expect(parseWhatsappSessionHealth(malformed)).toBeNull();
  });
});
