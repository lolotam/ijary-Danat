import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSION_DENIED_ACTION, recordPermissionDenied } from "./permissionAudit";

/** عميل Supabase وهمي يكتفي بتسجيل نداءات write_audit. */
function stubClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as never;
}

describe("recordPermissionDenied", () => {
  let rpc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rpc = vi.fn().mockResolvedValue({ data: "audit-id", error: null });
  });

  /**
   * `audit_logs` has carried `result` and `error_code` since migration 03 and
   * only notification dispatch ever used them, so the Audit screen could show
   * what a person did and never what they were stopped from doing.
   */
  it("records the missing permission and the action it blocked", async () => {
    await recordPermissionDenied({
      supabase: stubClient(rpc),
      permission: "payments.reverse",
      attempted: "payment.reverse",
      outcome: "denied",
    });

    expect(rpc).toHaveBeenCalledWith("write_audit", {
      p_action: PERMISSION_DENIED_ACTION,
      p_entity_type: null,
      p_entity_id: null,
      p_before: null,
      p_after: { attempted: "payment.reverse", permission: "payments.reverse" },
      p_result: "failure",
      p_error_code: "FORBIDDEN",
    });
  });

  /**
   * Review finding on PR #206. The call sites refuse on
   * `permissionError || !allowed`, which merges two different facts. Recording
   * an errored `has_permission` RPC as a denial would put a decision in the
   * security trail that nobody actually made.
   */
  it("records a failed check as an error, not as a decision to refuse", async () => {
    await recordPermissionDenied({
      supabase: stubClient(rpc),
      permission: "payments.reverse",
      attempted: "payment.reverse",
      outcome: "check-failed",
    });

    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({ p_result: "error", p_error_code: "PERMISSION_CHECK_FAILED" }),
    );
  });

  /** An audit outage must never turn a refused action into an allowed one. */
  it("resolves when the audit write itself fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockRejectedValue(new Error("PostgREST is down"));

    await expect(
      recordPermissionDenied({
        supabase: stubClient(rpc),
        permission: "payments.reverse",
        attempted: "payment.reverse",
        outcome: "denied",
      }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
