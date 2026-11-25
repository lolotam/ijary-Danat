import { describe, expect, it } from "vitest";

import type { PortalContractOption } from "@/hooks/usePortalData";
import { portalContractLabel, portalContractStatusKey } from "@/lib/portalContractLabel";

const base: PortalContractOption = {
  id: "c1",
  code: "CON-00005",
  type: "lease",
  state: "active",
  start_date: "2026-01-01",
  end_date: "2026-12-31",
  monthly_amount: 300,
};

describe("portalContractLabel", () => {
  it.each([
    [1, "ACTIVE", "1-CON-00005 (ACTIVE)"],
    [2, "INACTIVE", "2-CON-00005 (INACTIVE)"],
  ])("puts position %s first, then the code, then the status", (position, status, expected) => {
    expect(portalContractLabel(base, position, status)).toBe(expected);
  });
});

describe("portalContractStatusKey", () => {
  it("calls an active contract active", () => {
    expect(portalContractStatusKey("active")).toBe("portal.contract.status.active");
  });

  it.each(["draft", "frozen", "suspended", "expired", "renewed", "terminated"] as const)(
    "collapses %s to inactive",
    (state) => {
      expect(portalContractStatusKey(state)).toBe("portal.contract.status.inactive");
    },
  );
});
