import { beforeEach, describe, expect, it, vi } from "vitest";

// The handler is only reachable with `createServerFn` stubbed; the pure helpers
// below are unaffected by the stub and keep importing normally.
vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => fn._handler({ data, context: fn._context });
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((handler) => {
    fn._handler = handler;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middleware) => middleware),
    }),
  };
});

import { bulkImport, dedupeRowsByCode, ENTITIES_DEDUPED_BY_CODE } from "@/fns/bulkImport";

describe("dedupeRowsByCode", () => {
  it("imports a tenant once when the CSV repeats it per contract", () => {
    const rows = [
      { code: "T-1", name: "A" },
      { code: "T-1", name: "A" },
      { code: "T-2", name: "B" },
    ];
    expect(dedupeRowsByCode(rows)).toHaveLength(2);
  });

  it("keeps the first occurrence, matching the old primary-contract round trip", () => {
    const rows = [
      { code: "T-1", name: "first" },
      { code: "T-1", name: "second" },
    ];
    expect(dedupeRowsByCode(rows)[0].name).toBe("first");
  });

  it("leaves rows with a blank code alone — the importer generates one per row", () => {
    // `coalesce(nullif(row_data.code,''), public.next_tenant_code())` in the SQL
    // means a blank code is a NEW tenant each time, not a duplicate.
    expect(dedupeRowsByCode([{ code: "" }, { code: "" }])).toHaveLength(2);
  });

  it("treats whitespace-only codes as blank and does not collapse them", () => {
    expect(dedupeRowsByCode([{ code: "  " }, { code: "  " }])).toHaveLength(2);
  });

  it("ignores missing code fields the same way as blank — generate new tenants", () => {
    expect(dedupeRowsByCode([{ name: "A" }, { name: "B" }])).toHaveLength(2);
  });
});

describe("ENTITIES_DEDUPED_BY_CODE", () => {
  it("collapses contracts too — one-row-per-unit export re-imports without 23505", () => {
    const rows = [
      { code: "CTR-1", unit_code: "U-1" },
      { code: "CTR-1", unit_code: "U-2" },
      { code: "CTR-2", unit_code: "U-9" },
    ];
    expect(dedupeRowsByCode(rows).map((row) => row.unit_code)).toEqual(["U-1", "U-9"]);
  });

  it("covers exactly the two entities whose exports repeat a code", () => {
    // Deduping any other entity would silently drop legitimate rows: units and
    // expenses share no code across rows, and contracts rows legitimately repeat
    // tenant_code, which is NOT the dedupe key.
    expect([...ENTITIES_DEDUPED_BY_CODE]).toEqual(["tenants", "contracts"]);
  });
});

/**
 * يسجّل رفض الاستيراد بسبب الصلاحية.
 *
 * Review finding on PR #206: a direct call to this endpoint by an unauthorized
 * user was refused and left no trace, so the audit screen could not show a
 * bulk-import attempt that was stopped. The refusal itself is unchanged — only
 * the record is new, and the row must say whether a decision was made or the
 * check never ran.
 */
describe("bulkImport permission refusal", () => {
  /** يجهّز عميل Supabase مزيَّفاً بنتيجة تحقق صلاحية محدَّدة. */
  function arrange(permission: { data: unknown; error: unknown }) {
    const rpc = vi.fn((name: string) =>
      name === "has_permission" ? permission : { data: null, error: null },
    );
    (bulkImport as any)._context = { supabase: { rpc }, userId: "test-user-id" };
    return rpc;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "the user lacks the entity permission",
      { data: false, error: null },
      { p_result: "failure", p_error_code: "FORBIDDEN" },
    ],
    [
      "the permission check itself errors",
      { data: null, error: { message: "boom" } },
      { p_result: "error", p_error_code: "PERMISSION_CHECK_FAILED" },
    ],
  ])("refuses, imports nothing and records why when %s", async (_scenario, permission, audited) => {
    const rpc = arrange(permission as { data: unknown; error: unknown });

    await expect(
      (bulkImport as any)({ entity: "tenants", rows: [{ code: "T-1" }] }),
    ).rejects.toBeTruthy();

    expect(rpc).not.toHaveBeenCalledWith("bulk_import_phase6", expect.anything());
    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "permission.denied",
        // The entity names what was attempted, so the trail says which import
        // was stopped rather than only that some import was.
        p_after: expect.objectContaining({ attempted: "import.tenants" }),
        ...audited,
      }),
    );
  });
});
