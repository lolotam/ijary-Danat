import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { companyOrigin, companyOriginById } from "./companyUrl.server";

const originalRootHost = process.env.PLATFORM_ROOT_HOST;

afterEach(() => {
  if (originalRootHost === undefined) delete process.env.PLATFORM_ROOT_HOST;
  else process.env.PLATFORM_ROOT_HOST = originalRootHost;
});

/**
 * يبني عميل قاعدة بيانات وهمياً يعيد صف الشركة المعطى لاستعلام `companies`.
 */
function companiesDb(row: { slug: string } | null, seenIds: string[] = []) {
  const query = {
    select: () => query,
    eq: (_column: string, value: string) => {
      seenIds.push(value);
      return query;
    },
    single: async () =>
      row ? { data: row, error: null } : { data: null, error: { message: "0 rows" } },
  };
  return { from: () => query } as unknown as Parameters<typeof companyOriginById>[0];
}

describe("companyOrigin", () => {
  it.each([
    ["acme.ijary.app", "https://acme.ijary.app"],
    ["portal.acme-estates.com", "https://portal.acme-estates.com"],
    ["acme.localhost", "http://acme.localhost"],
    ["localhost:3000", "http://localhost:3000"],
  ])("builds an absolute origin for %s", (host, expected) => {
    expect(companyOrigin(host)).toBe(expected);
  });
});

describe("companyOriginById", () => {
  it("links to the company's own subdomain, not a platform-wide base url", async () => {
    process.env.PLATFORM_ROOT_HOST = "ijary.app";
    const seenIds: string[] = [];

    const origin = await companyOriginById(companiesDb({ slug: "acme" }, seenIds), "company-a");

    expect(origin).toBe("https://acme.ijary.app");
    expect(seenIds).toEqual(["company-a"]);
  });

  it("throws instead of guessing a host when the company row is not readable", async () => {
    await expect(companyOriginById(companiesDb(null), "company-b")).rejects.toThrow(
      "Company company-b has no readable address",
    );
  });
});

/**
 * يجمع مسارات ملفات الشيفرة الإنتاجية (غير الاختبارات) تحت مجلد.
 */
function productionSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return productionSources(path);
    const isSource = /\.(ts|tsx)$/.test(name) && !/\.(test|sqltest|testkit)\./.test(name);
    return isSource ? [path] : [];
  });
}

// Regression (T052q, second US1 review 2026-11-26): payment redirects, the
// WhatsApp-disconnect alert and the Pay Now link fell back to the single-company
// Danat host, sending every company's renters to Danat's site.
describe("no single-company base url fallback", () => {
  it("no production file falls back to the danat-future.com host", () => {
    const offenders = productionSources(join(process.cwd(), "src")).filter((path) =>
      /APP_BASE_URL\s*\|\|\s*["']https:\/\/danat-future\.com/.test(readFileSync(path, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
