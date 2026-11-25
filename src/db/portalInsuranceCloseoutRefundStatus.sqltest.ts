import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  arrangeHeldDeposit,
  insertPostedRefund,
  insuranceTotal,
  recordCloseoutDisposition,
} from "@/db/portalInsuranceFixtures";
import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/** يقرأ `refund_total` المخزّن على الإغلاق المكتمل دون المرور بالإجمالي. */
async function closeoutRefundTotal(client: PoolClient, contractId: string): Promise<number> {
  const { rows } = await client.query<{ refund_total: string }>(
    `select refund_total from public.contract_closeouts
      where contract_id = $1 and status = 'completed'`,
    [contractId],
  );
  return Number(rows[0].refund_total);
}

/**
 * يربط إغلاقًا مكتملًا باسترداد مرحّل بنفس مبلغ التأمين.
 *
 * Migration 85 flips `refunds.status` and leaves `refund_total` on the
 * completed header. These cases need the FK that `close_out_contract`
 * writes so void/reverse can be told from a snapshot-only close-out.
 */
async function arrangeLinkedRefundedCloseout(
  client: PoolClient,
  input: {
    collected: number;
    refundAmount: number;
    deductionsTotal?: number;
    settledTotal?: number;
  },
) {
  const fixture = await arrangeHeldDeposit(client, input.collected);
  const refundId = await insertPostedRefund(client, {
    tenantId: fixture.tenantId,
    contractId: fixture.contractId,
    amount: input.refundAmount,
  });
  await recordCloseoutDisposition(client, {
    contractId: fixture.contractId,
    tenantId: fixture.tenantId,
    actorId: fixture.actorId,
    status: "completed",
    depositHeld: input.collected,
    deductionsTotal: input.deductionsTotal ?? 0,
    settledTotal: input.settledTotal ?? 0,
    refundTotal: input.refundAmount,
    refundId,
  });
  return { ...fixture, refundId };
}

/**
 * Codex P1 on PR #212: void/reverse restore the holding because they change
 * the linked refund's status, not `contract_closeouts.refund_total`. Generic
 * refunds stay out — only `refund_id` on a completed close-out classifies
 * the disposal.
 */
describe("a linked close-out refund follows void and reverse, not the snapshot (migration 216)", () => {
  test("a posted linked refund still reduces the held total", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeLinkedRefundedCloseout(client, {
        collected: 1000,
        refundAmount: 1000,
      });

      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(0);
    });
  });

  test.each([
    ["void_refund", "select public.void_refund($1, 'entered in error')"],
    ["reverse_refund", "select * from public.reverse_refund($1, 'tenant returned the cheque')"],
  ])("%s restores the holding while refund_total stays", async (_action, sql) => {
    await withRollback(async (client) => {
      const fixture = await arrangeLinkedRefundedCloseout(client, {
        collected: 1000,
        refundAmount: 1000,
      });
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(0);
      await client.query(sql, [fixture.refundId]);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(1000);
      expect(await closeoutRefundTotal(client, fixture.contractId)).toBe(1000);
    });
  });

  test("voiding the linked refund leaves completed deductions and settlements in the net", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeLinkedRefundedCloseout(client, {
        collected: 1000,
        refundAmount: 650,
        deductionsTotal: 200,
        settledTotal: 150,
      });
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(0);

      await client.query(`select public.void_refund($1, 'refund was a duplicate')`, [
        fixture.refundId,
      ]);

      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(650);
    });
  });
});
