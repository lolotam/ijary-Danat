import { describe, expect, test } from "vitest";

import {
  emptyPaymentFilters,
  hasActivePaymentFilters,
  toPaymentQueryParams,
  type PaymentFilters,
} from "./paymentFilters";

function filters(overrides: Partial<PaymentFilters> = {}): PaymentFilters {
  return { ...emptyPaymentFilters, ...overrides };
}

describe("hasActivePaymentFilters", () => {
  test("no filters set", () => {
    expect(hasActivePaymentFilters(emptyPaymentFilters)).toBe(false);
  });

  test.each([
    ["dateFrom", "2026-01-01"],
    ["dateTo", "2026-01-31"],
    ["amountMin", "0"],
    ["amountMax", "500"],
    ["method", "cash"],
    ["status", "confirmed"],
    ["tenantId", "t-1"],
  ])("%s alone counts as filtered", (key, value) => {
    expect(hasActivePaymentFilters(filters({ [key]: value }))).toBe(true);
  });
});

describe("toPaymentQueryParams", () => {
  test("sends nothing when nothing is filtered", () => {
    expect(toPaymentQueryParams(emptyPaymentFilters)).toEqual({});
  });

  test("an empty select is absent, never sent as an empty string", () => {
    // `method: ""` would ask PostgREST for payments whose method is the empty
    // string and return none — a filter that silently empties the table.
    const params = toPaymentQueryParams(filters({ method: "", status: "", tenantId: "" }));
    expect("method" in params).toBe(false);
    expect("status" in params).toBe(false);
    expect("tenantId" in params).toBe(false);
  });

  test("passes the set filters through", () => {
    expect(
      toPaymentQueryParams(
        filters({
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
          method: "audit_adjustment",
          status: "confirmed",
          tenantId: "t-9",
        }),
      ),
    ).toEqual({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      method: "audit_adjustment",
      status: "confirmed",
      tenantId: "t-9",
    });
  });

  test("a zero lower bound survives — it is a real filter, not an empty one", () => {
    // Guards the `!= null` check. A truthiness test drops 0 and the filter
    // silently does nothing.
    expect(toPaymentQueryParams(filters({ amountMin: "0" })).amountMin).toBe(0);
  });

  test("parses fils-precision amounts", () => {
    const params = toPaymentQueryParams(filters({ amountMin: "3.500", amountMax: "1250.750" }));
    expect(params.amountMin).toBe(3.5);
    expect(params.amountMax).toBe(1250.75);
  });

  test.each(["", "-", "abc", "1.2.3"])("drops the unparseable amount %s", (raw) => {
    // Sending NaN serialises into the URL as the literal text and fails the
    // request, rather than the filter harmlessly doing nothing.
    const params = toPaymentQueryParams(filters({ amountMin: raw }));
    expect("amountMin" in params).toBe(false);
  });

  test("a min without a max is a valid one-sided range", () => {
    const params = toPaymentQueryParams(filters({ amountMin: "100" }));
    expect(params.amountMin).toBe(100);
    expect("amountMax" in params).toBe(false);
  });
});
