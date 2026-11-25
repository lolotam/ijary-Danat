import { describe, expect, test } from "vitest";

import {
  GATEWAY_PAYMENT_METHODS,
  formatPaymentMethod,
  isGatewayMethod,
} from "./paymentMethodDisplay";

/** Stands in for the real dictionary: echoes the key's last segment, so an
 *  assertion failing means the wrong key was built, not the wrong translation. */
const t = (key: string): string => {
  if (key === "paymentMethod.gatewayGroup") return "Payment link ({method})";
  return key.replace("paymentMethod.", "");
};

describe("isGatewayMethod", () => {
  test.each(["payment_link", "knet", "card", "applepay", "googlepay"])(
    "%s came through the gateway",
    (method) => {
      expect(isGatewayMethod(method)).toBe(true);
    },
  );

  test.each(["cash", "cheque", "bank_transfer", "audit_adjustment"])("%s did not", (method) => {
    expect(isGatewayMethod(method)).toBe(false);
  });

  test.each([null, undefined, ""])("%s is not a gateway method", (method) => {
    expect(isGatewayMethod(method)).toBe(false);
  });
});

describe("formatPaymentMethod", () => {
  test.each([
    ["knet", "Payment link (knet)"],
    ["card", "Payment link (card)"],
    ["applepay", "Payment link (applepay)"],
    ["googlepay", "Payment link (googlepay)"],
  ])("%s is grouped under Payment link but keeps its instrument", (method, expected) => {
    expect(formatPaymentMethod(method, t)).toBe(expected);
  });

  test("payment_link itself is not nested inside its own group label", () => {
    // "Payment link (Payment link)" is what a naive implementation produces.
    expect(formatPaymentMethod("payment_link", t)).toBe("payment_link");
  });

  test.each(["cash", "cheque", "bank_transfer", "audit_adjustment"])(
    "%s passes through untouched",
    (method) => {
      expect(formatPaymentMethod(method, t)).toBe(method);
    },
  );

  test.each([null, undefined])("renders an em dash for %s", (method) => {
    expect(formatPaymentMethod(method, t)).toBe("—");
  });

  test("every gateway method in the constant is actually grouped", () => {
    // Guards the two from drifting apart: adding a method to the constant
    // without the formatter honouring it would be silent.
    for (const method of GATEWAY_PAYMENT_METHODS) {
      if (method === "payment_link") continue;
      expect(formatPaymentMethod(method, t)).toMatch(/^Payment link \(/);
    }
  });
});
