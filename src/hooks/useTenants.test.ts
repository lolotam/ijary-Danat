import { describe, expect, it } from "vitest";

import {
  buildTenantActiveLocations,
  primaryShopBrandUrls,
  TENANT_DOCUMENT_MAX_BYTES,
  TENANT_DOCUMENT_TOO_LARGE,
  TENANT_DOCUMENT_UNSUPPORTED_TYPE,
  validateDocumentFile,
} from "@/hooks/useTenants";
import type { BrandAssetUrls } from "@/lib/brandLogos";

/**
 * عقد نشط بلا وحدات — الوحدات لا تدخل في لصق الشعار.
 */
function contract(id: string, startDate: string) {
  return {
    id,
    code: `CTR-${id}`,
    state: "active" as const,
    start_date: startDate,
    end_date: null,
    monthly_amount: 100,
    unit_ids: [] as string[],
  };
}

/**
 * خريطة علامات جاهزة للاختبار، مفتاحها معرّف العقد.
 */
function brands(entries: Array<[string, Partial<BrandAssetUrls>]>): Map<string, BrandAssetUrls> {
  return new Map(
    entries.map(([contractId, urls]) => [
      contractId,
      { logoUrl: urls.logoUrl ?? null, cardUrl: urls.cardUrl ?? null },
    ]),
  );
}

describe("buildTenantActiveLocations", () => {
  it("gives each of two contracts its own logo, not the primary's", () => {
    // The list used to stamp brands.get(locations[0]) on the tenant and never
    // on the location, so a second shop inherited the first logo.
    const locations = buildTenantActiveLocations(
      [contract("c-shop-a", "2026-01-01"), contract("c-shop-b", "2026-02-01")],
      new Map(),
      new Map(),
      brands([
        ["c-shop-a", { logoUrl: "/brands/alpha.png", cardUrl: "/cards/alpha.png" }],
        ["c-shop-b", { logoUrl: "/brands/beta.png", cardUrl: "/cards/beta.png" }],
      ]),
    );

    expect(locations).toHaveLength(2);
    expect(locations[0].logoUrl).toBe("/brands/alpha.png");
    expect(locations[1].logoUrl).toBe("/brands/beta.png");
    expect(locations[0].logoUrl).not.toBe(locations[1].logoUrl);
    expect(locations[0].cardUrl).toBe("/cards/alpha.png");
    expect(locations[1].cardUrl).toBe("/cards/beta.png");
    expect(locations[0].contract.id).toBe("c-shop-a");
    expect(locations[1].contract.id).toBe("c-shop-b");
  });

  it("leaves a single-contract tenant on its own brand", () => {
    const locations = buildTenantActiveLocations(
      [contract("c-only", "2026-03-01")],
      new Map(),
      new Map(),
      brands([["c-only", { logoUrl: "/brands/solo.png", cardUrl: "/cards/solo.png" }]]),
    );

    expect(locations).toHaveLength(1);
    expect(locations[0].logoUrl).toBe("/brands/solo.png");
    expect(locations[0].cardUrl).toBe("/cards/solo.png");
  });

  it("does not borrow the other contract's logo when a brand is missing", () => {
    // This is the actual defect: a second shop with no brand used to show
    // the first shop's logo because the tenant-level field was the only source.
    const locations = buildTenantActiveLocations(
      [contract("c-branded", "2026-01-01"), contract("c-bare", "2026-04-01")],
      new Map(),
      new Map(),
      brands([["c-branded", { logoUrl: "/brands/alpha.png", cardUrl: "/cards/alpha.png" }]]),
    );

    expect(locations[0].logoUrl).toBe("/brands/alpha.png");
    expect(locations[1].logoUrl).toBeNull();
    expect(locations[1].cardUrl).toBeNull();
    expect(locations[1].logoUrl).not.toBe(locations[0].logoUrl);
  });
});

describe("primaryShopBrandUrls", () => {
  it("keeps the tenant-level shop logo on the primary contract", () => {
    const locations = buildTenantActiveLocations(
      [contract("c-primary", "2026-01-01"), contract("c-second", "2026-02-01")],
      new Map(),
      new Map(),
      brands([
        ["c-primary", { logoUrl: "/brands/primary.png", cardUrl: "/cards/primary.png" }],
        ["c-second", { logoUrl: "/brands/second.png", cardUrl: "/cards/second.png" }],
      ]),
    );

    expect(primaryShopBrandUrls(locations)).toEqual({
      shopLogoUrl: "/brands/primary.png",
      shopCardUrl: "/cards/primary.png",
    });
  });

  it("returns nulls when the tenant has no active contract", () => {
    expect(primaryShopBrandUrls([])).toEqual({ shopLogoUrl: null, shopCardUrl: null });
  });
});

/**
 * يبني ملفًا بحجم مزيف دون تخصيص المخزن — اختبار السقف لا يحتاج 50 م.ب حقيقية.
 */
function documentFile(options: { name: string; type: string; size: number }): File {
  const file = new File(["x"], options.name, { type: options.type });
  Object.defineProperty(file, "size", { value: options.size });
  return file;
}

describe("validateDocumentFile", () => {
  it("accepts a scanned contract that previously failed the 10 MB client cap", () => {
    // Production incident 2026-08-23: CON-00026 document upload was blocked at
    // 10 MB while storage-api FILE_SIZE_LIMIT was already 50 MiB.
    expect(() =>
      validateDocumentFile(
        documentFile({
          name: "contract.pdf",
          type: "application/pdf",
          size: 10 * 1024 * 1024 + 1,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a file one byte over the storage-api ceiling", () => {
    expect(() =>
      validateDocumentFile(
        documentFile({
          name: "contract.pdf",
          type: "application/pdf",
          size: TENANT_DOCUMENT_MAX_BYTES + 1,
        }),
      ),
    ).toThrow(TENANT_DOCUMENT_TOO_LARGE);
  });

  it("rejects a non-PDF non-image even when it is small", () => {
    expect(() =>
      validateDocumentFile(
        documentFile({
          name: "notes.docx",
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 1024,
        }),
      ),
    ).toThrow(TENANT_DOCUMENT_UNSUPPORTED_TYPE);
  });
});
