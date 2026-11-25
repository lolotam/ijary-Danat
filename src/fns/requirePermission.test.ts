/**
 * بوابة الصلاحيات المشتركة: ترفض، وتسجّل، وترمي خطأً لا استجابة.
 *
 * This helper replaced the same preamble written out in 48 files. Three
 * properties are load-bearing and each has a test below, because the versions
 * it replaced got one or another of them wrong:
 *   1. the refusal REJECTS — a thrown `Response` resolves client-side via
 *      x-tss-raw and fires the caller's success toast over nothing;
 *   2. an errored check is recorded as `PERMISSION_CHECK_FAILED`, not
 *      `FORBIDDEN` — a check that never ran is not a decision anyone made;
 *   3. the guarded work never starts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  requireAnyPermission,
  requirePermission,
  requireRole,
  requireStaff,
} from "@/fns/requirePermission";

const rpc = vi.fn();
const context = { supabase: { rpc }, userId: "user-1" } as never;

const INPUT = {
  code: "invoices.update",
  attempted: "invoice.set_paid",
  refusal: "You do not have permission to change invoice payment state.",
} as const;

/** يرجّع نداء write_audit الوحيد الذي كُتب، إن وُجد. */
function auditCall() {
  return rpc.mock.calls.find(([fn]) => fn === "write_audit");
}

beforeEach(() => {
  rpc.mockReset();
});

describe("requirePermission", () => {
  it("returns without writing an audit row when the permission is held", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });

    await expect(requirePermission(context, INPUT)).resolves.toBeUndefined();

    expect(auditCall()).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects with an Error, never a Response, when the permission is refused", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: null });

    const refused = requirePermission(context, INPUT);

    await expect(refused).rejects.toBeInstanceOf(Error);
    await expect(refused).rejects.not.toBeInstanceOf(Response);
    await expect(refused).rejects.toThrow(INPUT.refusal);
  });

  it("records a refusal as FORBIDDEN", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: null });

    await requirePermission(context, INPUT).catch(() => {});

    expect(auditCall()?.[1]).toMatchObject({
      p_action: "permission.denied",
      p_result: "failure",
      p_error_code: "FORBIDDEN",
      p_after: { attempted: INPUT.attempted, permission: INPUT.code },
    });
  });

  it("records a check that never ran as PERMISSION_CHECK_FAILED, not a denial", async () => {
    // The distinction PR #206 asked for: recording this as FORBIDDEN would put
    // a decision in the security trail that nobody made.
    rpc.mockResolvedValueOnce({ data: null, error: { message: "rpc exploded" } });
    rpc.mockResolvedValueOnce({ data: null, error: null });

    await requirePermission(context, INPUT).catch(() => {});

    expect(auditCall()?.[1]).toMatchObject({
      p_result: "error",
      p_error_code: "PERMISSION_CHECK_FAILED",
    });
  });

  it("carries the entity through to the audit row when the caller names one", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: null });

    await requirePermission(context, {
      ...INPUT,
      entityType: "invoice",
      entityId: "inv-7",
    }).catch(() => {});

    expect(auditCall()?.[1]).toMatchObject({
      p_entity_type: "invoice",
      p_entity_id: "inv-7",
    });
  });

  it("still refuses when the audit write itself fails", async () => {
    // Best-effort auditing: an audit outage must never turn a refused action
    // into an allowed one.
    rpc.mockResolvedValueOnce({ data: false, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "audit down" } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(requirePermission(context, INPUT)).rejects.toThrow(INPUT.refusal);

    logged.mockRestore();
  });
});

describe("requireAnyPermission", () => {
  const ANY = {
    codes: ["refunds.update", "refunds.create"],
    attempted: "notification.refund_recorded",
    refusal: "You do not have permission to record a refund.",
  } as const;

  /** يجيب has_permission بحسب الرمز، ويقبل كتابة التدقيق دائماً. */
  function answer(held: Record<string, boolean>) {
    rpc.mockImplementation(async (fn: string, args: { _code?: string }) =>
      fn === "has_permission"
        ? { data: held[args._code ?? ""] ?? false, error: null }
        : { data: null, error: null },
    );
  }

  it.each([
    ["the first code", { "refunds.update": true }],
    ["only the second code", { "refunds.create": true }],
  ])("admits a caller holding %s without writing an audit row", async (_label, held) => {
    answer(held);

    await expect(requireAnyPermission(context, ANY)).resolves.toBeUndefined();
    expect(auditCall()).toBeUndefined();
  });

  it("records ONE denial, against the last code, when every code is refused", async () => {
    answer({});

    await expect(requireAnyPermission(context, ANY)).rejects.toThrow(ANY.refusal);
    const audits = rpc.mock.calls.filter(([fn]) => fn === "write_audit");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.[1]).toMatchObject({
      p_after: { attempted: ANY.attempted, permission: "refunds.create" },
      p_error_code: "FORBIDDEN",
    });
  });
});

describe("role gates (requireRole / requireStaff)", () => {
  // Pass 2 residual: 19 has_role / is_staff gates — erase all data, restore a
  // backup, delete a user — refused without an audit row, so the Audit screen
  // could never show who was stopped from doing them.
  const ROLE_INPUT = {
    attempted: "data.erase_all",
    refusal: "Only an admin may reset the database.",
  } as const;

  it.each([
    ["requireRole", () => requireRole(context, "admin", ROLE_INPUT), "has_role"],
    ["requireStaff", () => requireStaff(context, ROLE_INPUT), "is_staff"],
  ] as const)(
    "%s admits a caller who holds the role without writing an audit row",
    async (_name, gate, fn) => {
      rpc.mockResolvedValueOnce({ data: true, error: null });

      await expect(gate()).resolves.toBeUndefined();
      expect(rpc).toHaveBeenCalledWith(fn, expect.objectContaining({ _user_id: "user-1" }));
      expect(auditCall()).toBeUndefined();
    },
  );

  it.each([
    ["requireRole", () => requireRole(context, "admin", ROLE_INPUT), "role:admin"],
    ["requireStaff", () => requireStaff(context, ROLE_INPUT), "role:staff"],
  ] as const)(
    "%s records a refusal against the role, then rejects",
    async (_name, gate, permission) => {
      rpc.mockResolvedValueOnce({ data: false, error: null });
      rpc.mockResolvedValueOnce({ data: null, error: null });

      await expect(gate()).rejects.toThrow(ROLE_INPUT.refusal);
      expect(auditCall()?.[1]).toMatchObject({
        p_error_code: "FORBIDDEN",
        p_after: { attempted: ROLE_INPUT.attempted, permission },
      });
    },
  );

  it("records a role check that errored as PERMISSION_CHECK_FAILED", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "rpc exploded" } });
    rpc.mockResolvedValueOnce({ data: null, error: null });

    await expect(requireRole(context, "admin", ROLE_INPUT)).rejects.toThrow(ROLE_INPUT.refusal);
    expect(auditCall()?.[1]).toMatchObject({ p_error_code: "PERMISSION_CHECK_FAILED" });
  });
});
