import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { collectInsurance, insuranceTotal, seedUserWithRole } from "@/db/portalInsuranceFixtures";
import {
  actAs,
  actAsSuperuser,
  captureRaiseError,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/** هل يستطيع الجالس الحالي قراءة صفوف التأمين نفسها؟ */
async function readableInsuranceRows(client: PoolClient, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `select count(*) from public.insurance_payments where tenant_id = $1`,
    [tenantId],
  );
  return Number(rows[0].count);
}

/**
 * Migration 216. `insurance_payments` had one SELECT policy since migration 56
 * — `insurance_payments_staff_read` — so a tenant session read nothing, and the
 * portal's new "Insurance paid" card would have shown zero for everyone.
 *
 * The risk in opening it is the one that took eight review rounds on PR #209:
 * a `hide_from_portal` lease must take its insurance with it, or the roof
 * contract the tenant is not supposed to know about announces itself through a
 * dashboard total.
 */
describe("a tenant reads their insurance total, and nothing else (migration 216)", () => {
  /** يجهّز مستأجرًا بعقدين: أحدهما مخفي عن البوابة، والآخر ظاهر، ولكلٍّ تأمين. */
  async function arrange(client: PoolClient) {
    const shop = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
    await collectInsurance(client, {
      contractId: shop.contractId,
      tenantId: shop.tenantId,
      unitId: shop.unitId,
      amount: 300,
    });

    // A second unit and contract for the same tenant — the roof — carrying its
    // own insurance, then hidden.
    const roofUnit = await client.query<{ id: string }>(
      `insert into public.units (code, property_id, name) values ($1, $2, 'Roof') returning id`,
      [`U-ins-${shop.contractId.slice(0, 8)}`, shop.propertyId],
    );
    const roof = await client.query<{ id: string }>(
      `insert into public.contracts
         (code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state, hide_from_portal)
       values ($1, $2, '2026-01-01'::date, '2026-12-31'::date, 1, 0, 0, 'active'::public.contract_states, true)
       returning id`,
      [`C-ins-${shop.contractId.slice(0, 8)}`, shop.tenantId],
    );
    await client.query(
      `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
       values ($1, $2, 200, 1)`,
      [roof.rows[0].id, roofUnit.rows[0].id],
    );
    await collectInsurance(client, {
      contractId: roof.rows[0].id,
      tenantId: shop.tenantId,
      unitId: roofUnit.rows[0].id,
      amount: 900,
    });

    const tenantUser = await seedUserWithRole(client, "tenant");
    await client.query(`update public.profiles set tenant_id = $1 where id = $2`, [
      shop.tenantId,
      tenantUser,
    ]);
    return { ...shop, tenantUser, roofContractId: roof.rows[0].id };
  }

  test("the tenant reads the insurance on the contract they can see", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);

      await actAs(client, "authenticated", fixture.tenantUser);
      const total = await insuranceTotal(client, fixture.tenantId);
      // The ledger rows themselves stay out of reach: they carry a staff note,
      // created_by, and internal unit and building ids that the dashboard does
      // not need and the tenant has no business reading. Review round 1 on #212.
      const rowsVisible = await readableInsuranceRows(client, fixture.tenantId);
      await actAsSuperuser(client);

      expect(total).toBe(300);
      expect(rowsVisible).toBe(0);
    });
  });

  /**
   * The finding this policy is written in the positive to avoid: a
   * `not exists (... where c.hide_from_portal)` would run under the contracts
   * policy, which has already hidden that row from this tenant — so the
   * subquery finds nothing, the negation holds, and every insurance row passes.
   */
  test("the hidden contract's insurance never reaches the tenant", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);

      await actAs(client, "authenticated", fixture.tenantUser);
      const total = await insuranceTotal(client, fixture.tenantId);
      await actAsSuperuser(client);

      // 300 from the shop alone; the roof's 900 is not in the sum at all.
      expect(total).toBe(300);
    });
  });

  // Revealing the roof gives its insurance back, which is what makes the test
  // above an assertion about `hide_from_portal` rather than about the join.
  test("revealing the contract brings its insurance back", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      await client.query(`update public.contracts set hide_from_portal = false where id = $1`, [
        fixture.roofContractId,
      ]);

      await actAs(client, "authenticated", fixture.tenantUser);
      const total = await insuranceTotal(client, fixture.tenantId);
      await actAsSuperuser(client);

      expect(total).toBe(1200);
    });
  });

  test("another tenant's insurance stays out of reach", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      const stranger = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await collectInsurance(client, {
        contractId: stranger.contractId,
        tenantId: stranger.tenantId,
        unitId: stranger.unitId,
        amount: 750,
      });

      await actAs(client, "authenticated", fixture.tenantUser);
      // The guard refuses outright rather than answering zero, which would be
      // indistinguishable from "they paid nothing". Through a savepoint: a raise
      // inside the surrounding transaction would poison it for the rollback.
      const error = await captureRaiseError(client, () =>
        insuranceTotal(client, stranger.tenantId),
      );
      await actAsSuperuser(client);

      expect((error as { code?: string })?.code).toBe("42501");
    });
  });

  /**
   * Staff get the same number the tenant does, deliberately. This function is
   * the portal's total, and the staff preview at `/portal?tenant=` is a view of
   * what the tenant sees — a preview that silently included a hidden lease
   * would defeat the point of hiding it. The Insurance tab reads the table
   * directly and is unaffected.
   */
  test("the staff preview sees the same total the tenant sees", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      const staffUser = await seedUserWithRole(client, "admin");

      await actAs(client, "authenticated", staffUser);
      const total = await insuranceTotal(client, fixture.tenantId);
      await actAsSuperuser(client);

      expect(total).toBe(300);
    });
  });

  /**
   * Review round 2 on PR #212. Migration 190 propagates invoices, payments and
   * receipts when staff reassign a contract to another tenant, but not
   * `insurance_payments`, and `syncContractInsurance` leaves an existing row
   * untouched when the deposit has not changed. Summing on the insurance row's
   * own `tenant_id` therefore credited the FORMER tenant with insurance for a
   * lease they no longer hold, while the new tenant saw none of it.
   */
  test("insurance follows the contract when it is reassigned", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      const newOwner = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      // Reassign the shop contract, exactly as staff do, leaving the insurance
      // row pointing at the old tenant.
      await client.query(`update public.contracts set tenant_id = $1 where id = $2`, [
        newOwner.tenantId,
        fixture.contractId,
      ]);

      expect(await insuranceTotal(client, newOwner.tenantId)).toBe(300);
      expect(await insuranceTotal(client, fixture.tenantId)).toBe(0);
    });
  });

  /**
   * Review round 3 on PR #212. The dashboard passes the selected contract to
   * the lease and invoice KPIs, so a tenant-wide insurance total sat beside one
   * contract's rent and attributed every lease's deposit to it. Switching
   * contracts changed everything on the screen except this card.
   */
  test("the total is scoped to the selected contract", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      await client.query(`update public.contracts set hide_from_portal = false where id = $1`, [
        fixture.roofContractId,
      ]);

      expect(await insuranceTotal(client, fixture.tenantId)).toBe(1200);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(300);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.roofContractId)).toBe(900);
    });
  });

  // Another tenant's contract id yields nothing rather than leaking, because
  // the ownership test is ANDed with it rather than replaced by it.
  test("a contract belonging to someone else sums to zero", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      const stranger = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      expect(await insuranceTotal(client, fixture.tenantId, stranger.contractId)).toBe(0);
    });
  });

  /**
   * Draft deposits can already be collected — `ContractFormDialog` mirrors a
   * positive deposit into `insurance_payments` on save, and the Insurance tab
   * plus the budget KPI keep counting that row. The portal still excludes
   * drafts: an unagreed lease is not money the tenant should be told the
   * office is holding for them.
   */
  test("a draft contract's deposit is not reported as insurance paid", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      await client.query(
        `update public.contracts set state = 'draft'::public.contract_states where id = $1`,
        [fixture.contractId],
      );

      expect(await insuranceTotal(client, fixture.tenantId)).toBe(0);
    });
  });
});
