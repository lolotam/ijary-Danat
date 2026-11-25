import { describe, expect, test } from "vitest";

import { closeoutSchema } from "@/lib/closeoutSchemas";

/**
 * يتحقق أن مخطط الإغلاق يقبل الطابع الزمني بالصيغة التي يرسلها PostgREST فعلاً.
 *
 * Regression test for the close-out wizard being unsubmittable (found
 * 2026-09-03). `expectedContractUpdatedAt` is fed from `contracts.updated_at`,
 * which PostgREST renders with a `+00:00` offset rather than a trailing `Z`.
 * Bare `z.string().datetime()` rejects the offset form, so `form.trigger()`
 * failed on a field the wizard renders no input for — the user saw only
 * "Fix required fields before submitting", with nothing highlighted, and no
 * close-out could ever be committed.
 *
 * Asserted against the schema directly: the shared `createServerFn` mock used by
 * the `src/fns` tests never runs `.validator()`, so a server-fn test cannot see
 * this. The existing close-out fn test passes `null` here, which is why a green
 * suite said nothing.
 */
describe("closeoutSchema accepts the timestamps PostgREST actually sends", () => {
  const validCloseout = {
    contractId: "d9d1e8bd-0204-46b1-afbc-661b278ad859",
    moveOutDate: "2026-09-30",
    outcome: "keep_terminated" as const,
    finalContractState: "terminated" as const,
    archiveTenant: false,
    deductions: [],
    invoiceActions: [],
    idempotencyKey: "35786395-4df2-429a-aa14-7e428d1339d3",
  };

  test.each([
    ["PostgREST offset form", "2026-09-02T10:04:38.624433+00:00"],
    ["UTC Z form", "2026-09-02T10:04:38.624433Z"],
    ["non-UTC offset", "2026-09-02T13:04:38.624433+03:00"],
    ["second precision, offset", "2026-09-02T10:04:38+00:00"],
  ])("%s is accepted", (_label, updatedAt) => {
    const result = closeoutSchema.safeParse({
      ...validCloseout,
      expectedContractUpdatedAt: updatedAt,
    });
    expect(result.success, result.success ? "" : result.error.issues[0]?.message).toBe(true);
  });

  test.each([
    ["null", null],
    ["omitted", undefined],
  ])("%s is still accepted — the field is optional", (_label, updatedAt) => {
    expect(
      closeoutSchema.safeParse({ ...validCloseout, expectedContractUpdatedAt: updatedAt }).success,
    ).toBe(true);
  });

  test("a non-timestamp is still rejected — widening the format did not disable the check", () => {
    const result = closeoutSchema.safeParse({
      ...validCloseout,
      expectedContractUpdatedAt: "2026-09-02",
    });
    expect(result.success).toBe(false);
  });
});
