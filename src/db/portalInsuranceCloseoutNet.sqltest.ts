import { afterAll, describe, expect, test } from "vitest";

import {
  arrangeHeldDeposit,
  insuranceTotal,
  recordCloseoutDisposition,
} from "@/db/portalInsuranceFixtures";
import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

// PR #212: close-out keeps the collection row after disposing the deposit.
// Each term must reduce the holding once; the historical snapshot cannot
// replace the collection ledger, and an over-disposed balance cannot be negative.
describe("completed close-outs net the live collected holding (migration 216)", () => {
  test.each([
    {
      scenario: "deductions",
      depositHeld: 1000,
      deductionsTotal: 400,
      settledTotal: 0,
      refundTotal: 0,
      expected: 600,
    },
    {
      scenario: "full refund",
      depositHeld: 1000,
      deductionsTotal: 0,
      settledTotal: 0,
      refundTotal: 1000,
      expected: 0,
    },
    {
      scenario: "invoice settlement",
      depositHeld: 1000,
      deductionsTotal: 0,
      settledTotal: 250,
      refundTotal: 0,
      expected: 750,
    },
    {
      scenario: "stale snapshot",
      depositHeld: 400,
      deductionsTotal: 100,
      settledTotal: 0,
      refundTotal: 0,
      expected: 900,
    },
    {
      scenario: "combined fractional disposals",
      depositHeld: 1000,
      deductionsTotal: 100.125,
      settledTotal: 200.25,
      refundTotal: 300.375,
      expected: 399.25,
    },
    {
      scenario: "disposals above corrected collection",
      depositHeld: 1200,
      deductionsTotal: 200,
      settledTotal: 0,
      refundTotal: 1000,
      expected: 0,
    },
  ])(
    "$scenario reports $expected held",
    async ({ scenario: _scenario, expected, ...disposition }) => {
      await withRollback(async (client) => {
        const fixture = await arrangeHeldDeposit(client, 1000);
        await recordCloseoutDisposition(client, {
          contractId: fixture.contractId,
          tenantId: fixture.tenantId,
          actorId: fixture.actorId,
          status: "completed",
          ...disposition,
        });

        expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(expected);
      });
    },
  );
});
