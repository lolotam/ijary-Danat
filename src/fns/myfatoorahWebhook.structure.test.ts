import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The settlement writes moved out of the webhook into gatewaySettlement.ts, then
// into gatewaySettlementWrites.ts (audit M2, Phase 2C); this guard follows them.
const source = readFileSync(resolve(process.cwd(), "src/fns/gatewaySettlementWrites.ts"), "utf8");

/**
 * يقتطع نص دالة واحدة من مصدر الويب هوك.
 */
function functionBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

describe("gateway provenance on payments", () => {
  it("writes payment_request_id on both the insert and the placeholder adoption", () => {
    // 192's backfill ran once. A payment the webhook inserts, or an admin
    // placeholder it adopts, that lacks the column would be labelled "manual"
    // by get_invoice_payment_breakdown for good.
    expect(functionBody("createConfirmedPaymentForInvoice")).toContain("payment_request_id:");
    expect(functionBody("adoptPlaceholderPayments")).toContain("payment_request_id:");
  });
});
