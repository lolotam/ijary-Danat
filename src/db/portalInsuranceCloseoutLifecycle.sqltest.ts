import { afterAll, describe, expect, test } from "vitest";

import {
  addVisibleLeaseWithInsurance,
  arrangeHeldDeposit,
  insuranceTotal,
  recordCloseoutDisposition,
} from "@/db/portalInsuranceFixtures";
import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Codex P1 on PR #212, lifecycle. Draft/cancelled close-outs have not
 * committed a disposal. Completed ones follow the contract across mixed
 * leases, a second close-out, a later collection on the unique insurance
 * row, and restore_contract leaving the completed header in place. Generic
 * `refunds` stay out of the sum — that table has no deposit discriminator.
 */
describe("close-out status and lease lifecycle do not leak or double insurance (migration 216)", () => {
  test("an active lease is not reduced by another contract's completed close-out", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 300);
      const ended = await addVisibleLeaseWithInsurance(client, fixture, 900);
      await client.query(
        `update public.contracts set state = 'terminated'::public.contract_states where id = $1`,
        [ended.contractId],
      );
      await recordCloseoutDisposition(client, {
        contractId: ended.contractId,
        tenantId: fixture.tenantId,
        actorId: fixture.actorId,
        status: "completed",
        // Clamp this corrected collection before summing so it cannot consume
        // the active lease's 300 when the historic disposal exceeds it.
        depositHeld: 1100,
        deductionsTotal: 200,
        refundTotal: 900,
      });

      expect(await insuranceTotal(client, fixture.tenantId)).toBe(300);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(300);
      expect(await insuranceTotal(client, fixture.tenantId, ended.contractId)).toBe(0);
    });
  });

  test.each(["draft", "cancelled"] as const)(
    "a %s close-out does not reduce the held total",
    async (status) => {
      await withRollback(async (client) => {
        const fixture = await arrangeHeldDeposit(client, 1000);
        await recordCloseoutDisposition(client, {
          contractId: fixture.contractId,
          tenantId: fixture.tenantId,
          actorId: fixture.actorId,
          status,
          depositHeld: 1000,
          deductionsTotal: 400,
          refundTotal: 600,
        });

        expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(1000);
      });
    },
  );

  test("two completed close-outs do not double the insurance holding", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 1000);
      await recordCloseoutDisposition(client, {
        contractId: fixture.contractId,
        tenantId: fixture.tenantId,
        actorId: fixture.actorId,
        status: "completed",
        depositHeld: 1000,
        deductionsTotal: 200,
        outcome: "freeze",
      });
      await recordCloseoutDisposition(client, {
        contractId: fixture.contractId,
        tenantId: fixture.tenantId,
        actorId: fixture.actorId,
        status: "completed",
        depositHeld: 1000,
        settledTotal: 150,
        refundTotal: 100,
      });

      // 1000 - 200 - 150 - 100. A row join would count the 1000 twice.
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(550);
    });
  });

  test("a later collection on the same insurance row still counts after close-out", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 1000);
      await recordCloseoutDisposition(client, {
        contractId: fixture.contractId,
        tenantId: fixture.tenantId,
        actorId: fixture.actorId,
        status: "completed",
        depositHeld: 1000,
        refundTotal: 1000,
      });
      await client.query(
        `update public.insurance_payments set amount = 1300 where contract_id = $1`,
        [fixture.contractId],
      );

      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(300);
    });
  });

  test("a restored live contract still nets its completed close-out", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 1000);
      await recordCloseoutDisposition(client, {
        contractId: fixture.contractId,
        tenantId: fixture.tenantId,
        actorId: fixture.actorId,
        status: "completed",
        depositHeld: 1000,
        refundTotal: 1000,
        outcome: "archive",
      });
      // restore_contract (migration 142) clears archived_at and can set state
      // back to active; it does not reverse the completed close-out or the money.
      await client.query(
        `update public.contracts
            set state = 'active'::public.contract_states, archived_at = null
          where id = $1`,
        [fixture.contractId],
      );

      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(0);
    });
  });

  test("a generic refund does not reduce the held total", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 300);
      await client.query(
        `insert into public.refunds (tenant_id, contract_id, amount, refund_date, post_action)
         values ($1, $2, 300, current_date, 'store')`,
        [fixture.tenantId, fixture.contractId],
      );

      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(300);
    });
  });
});
