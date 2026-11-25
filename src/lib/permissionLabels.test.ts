import { describe, expect, test } from "vitest";

import { permissionLabel } from "@/lib/permissionLabels";

describe("permissionLabel", () => {
  test("uses Arabic labels for a permission code", () => {
    expect(permissionLabel("payments.reverse", "ar")).toBe("المدفوعات: عكس الدفعة");
  });

  test("uses English labels for a permission code", () => {
    expect(permissionLabel("payments.reverse", "en")).toBe("Payments: Reverse payment");
  });
});
