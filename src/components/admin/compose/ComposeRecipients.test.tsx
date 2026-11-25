import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { routeAddition } from "@/components/admin/compose/ComposeRecipients";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/admin/compose/ComposeRecipients.tsx"),
  "utf8",
);

/**
 * يزيل التعليقات قبل البحث عن استدعاءات فعلية في الشيفرة.
 *
 * Without this, a comment saying "not useState of addresses" fails the very
 * assertion that exists to ban the pattern — the guard would be tripped by
 * its own rationale.
 */
const CODE_ONLY = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("routeAddition", () => {
  it("puts every picked tenant in To, including select-all", () => {
    expect(routeAddition(["a@x.com", "b@x.com"])).toEqual({ field: "to" });
    expect(routeAddition(["a@x.com"])).toEqual({ field: "to" });
    expect(routeAddition([])).toEqual({ field: "to" });
  });
});

describe("ComposeRecipients source", () => {
  it("fetches every tenant, not the default first page of ten", () => {
    // useTenants defaults to pageSize=10. Bare call makes "Select all" mean
    // the first page while the button says otherwise.
    expect(CODE_ONLY).toMatch(/useTenants\(\s*\{\s*pageSize:\s*1000/);
  });

  it("lists tenants without email as disabled rather than dropping them", () => {
    // Silently dropping records is a recurring defect; a disabled row plus a
    // visible count is the cheap defence.
    expect(CODE_ONLY).toMatch(/disabled=\{!/);
    expect(CODE_ONLY).toMatch(/inbox\.tenantsWithEmail/);
    expect(CODE_ONLY).toMatch(/visibleTenants\.map/);
  });

  it("merges into the to/bcc strings and never holds a parallel address list", () => {
    // A selected-addresses useState is what produces "I deleted an address
    // and it came back" on the next render. Ticked tenant *ids* inside the
    // open popover are fine; a second copy of the addresses is not.
    expect(CODE_ONLY).toMatch(/appendAddresses\(/);
    expect(CODE_ONLY).not.toMatch(/useState<string\[\]>\([^)]*@/);
    expect(CODE_ONLY).not.toMatch(/selectedAddresses/);
  });

  it("routes both Add selected and Select all through routeAddition", () => {
    expect(CODE_ONLY).toMatch(/routeAddition\(/);
    expect((CODE_ONLY.match(/mergeIntoHeaders\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(CODE_ONLY).not.toMatch(/addresses\.length\s*>\s*1\s*\?\s*["']bcc["']/);
  });
});
