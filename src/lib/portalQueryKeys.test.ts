import { describe, expect, test, vi } from "vitest";

import { PORTAL_QUERY_KEYS, invalidatePortalViews } from "@/lib/portalQueryKeys";

/**
 * تعديل إداري يجب أن يُبطل كل صفحات البوابة، لا صفحات الإدارة وحدها.
 *
 * Regression test (found 2026-09-03, widened by audit M22): staff open the
 * portal as a tenant (`/portal?tenant=<id>`) in the SAME React Query cache as
 * the admin app. The concession mutations invalidated only admin keys and the
 * preview kept serving the pre-discount lease; recording or reversing a
 * payment invalidated no portal key at all.
 *
 * Asserted on the exact key strings — a `toHaveBeenCalled` would pass just as
 * happily with an incomplete set.
 */
describe("PORTAL_QUERY_KEYS", () => {
  test("names all six portal data queries", () => {
    // A seventh portal query must be added here, and this test is where that
    // shows up — the list being short is exactly the defect M22 describes.
    expect([...PORTAL_QUERY_KEYS].sort()).toEqual([
      "portal-contracts",
      "portal-identity",
      "portal-invoice-summary",
      "portal-invoices",
      "portal-lease",
      "portal-payments",
    ]);
  });
});

describe("invalidatePortalViews", () => {
  test("invalidates every listed portal key by prefix", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    await invalidatePortalViews({ invalidateQueries } as never);

    expect(invalidateQueries.mock.calls.map(([argument]) => argument.queryKey)).toEqual(
      PORTAL_QUERY_KEYS.map((key) => [key]),
    );
  });
});
