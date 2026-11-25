import { describe, expect, it } from "vitest";

import { knetToastKey, markPaidToastKey } from "./paymentErrors";

describe("knetToastKey", () => {
  it("maps chronological Error to knetLinkOutOfOrder", () => {
    expect(knetToastKey(new Error("Invoices must be paid in chronological order."))).toBe(
      "invoices.knetLinkOutOfOrder",
    );
  });

  it("maps legacy Response-shaped 409 to knetLinkOutOfOrder", () => {
    expect(knetToastKey({ status: 409 })).toBe("invoices.knetLinkOutOfOrder");
  });

  it("maps no-payable-balance Error to knetLinkNoBalance", () => {
    expect(knetToastKey(new Error("No payable balance remains."))).toBe(
      "invoices.knetLinkNoBalance",
    );
  });

  it("maps tenant-not-authorized Error to knetLinkNotAuthorized", () => {
    expect(knetToastKey(new Error("You are not authorized to pay invoices for this tenant."))).toBe(
      "invoices.knetLinkNotAuthorized",
    );
  });

  it("maps staff permission Error to knetLinkNoPermission", () => {
    expect(knetToastKey(new Error("You do not have permission to create payment links."))).toBe(
      "invoices.knetLinkNoPermission",
    );
  });

  it("maps unrecognised Error message to knetLinkFailed", () => {
    expect(knetToastKey(new Error("MyFatoorah request failed."))).toBe("invoices.knetLinkFailed");
  });

  it("maps a raw object with internal text to knetLinkFailed without leaking it", () => {
    const key = knetToastKey({
      message: "stack at createPayment.ts:42:internal_secret_xyz",
      data: "ENODATA xattr missing",
    });
    expect(key).toBe("invoices.knetLinkFailed");
    expect(key).not.toContain("internal_secret");
    expect(key).not.toContain("ENODATA");
    expect(key).not.toContain("stack");
  });

  it("maps null and undefined to knetLinkFailed", () => {
    expect(knetToastKey(null)).toBe("invoices.knetLinkFailed");
    expect(knetToastKey(undefined)).toBe("invoices.knetLinkFailed");
  });
});

describe("markPaidToastKey", () => {
  it("maps chronological Error to markPaidOutOfOrder, not the KNET key", () => {
    expect(markPaidToastKey(new Error("Invoices must be paid in chronological order."))).toBe(
      "invoices.markPaidOutOfOrder",
    );
    expect(knetToastKey(new Error("Invoices must be paid in chronological order."))).toBe(
      "invoices.knetLinkOutOfOrder",
    );
  });

  it("maps unrecognised mark-paid failures to the generic error key", () => {
    expect(markPaidToastKey(new Error("invoice is cancelled"))).toBe("common.error");
  });
});
