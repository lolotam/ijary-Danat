import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

describe("contract_units", () => {
  it("carries one row per unit and totals onto the contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });

      const rows = await client.query(
        `select unit_id, monthly_amount, line_order from public.contract_units
          where contract_id = $1 order by line_order`,
        [fixture.contractId],
      );
      expect(rows.rowCount).toBe(3);
      expect(rows.rows.map((r) => Number(r.monthly_amount))).toEqual([400, 400, 400]);

      const total = await client.query(
        `select monthly_amount from public.contracts where id = $1`,
        [fixture.contractId],
      );
      expect(Number(total.rows[0].monthly_amount)).toBe(1200);
    });
  });

  it("keeps the contract total in step when a unit rent changes or is removed", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });

      await client.query(
        `update public.contract_units set monthly_amount = 550
          where contract_id = $1 and line_order = 1`,
        [fixture.contractId],
      );
      let total = await client.query(`select monthly_amount from public.contracts where id = $1`, [
        fixture.contractId,
      ]);
      expect(Number(total.rows[0].monthly_amount)).toBe(950);

      await client.query(
        `delete from public.contract_units where contract_id = $1 and line_order = 2`,
        [fixture.contractId],
      );
      total = await client.query(`select monthly_amount from public.contracts where id = $1`, [
        fixture.contractId,
      ]);
      expect(Number(total.rows[0].monthly_amount)).toBe(550);
    });
  });

  it("refuses the same unit twice on one contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const existing = await client.query(
        `select unit_id from public.contract_units where contract_id = $1`,
        [fixture.contractId],
      );
      // captureRaise, not `rejects.toThrow`: Postgres aborts the whole
      // transaction on any error, and withRollback's later statements would
      // then fail with "current transaction is aborted". See testDb.ts:100-106.
      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
           values ($1, $2, 100, 2)`,
          [fixture.contractId, existing.rows[0].unit_id],
        ),
      );
      expect(message).toMatch(/contract_units_contract_id_unit_id_key/);
    });
  });

  it("refuses a unit already held by another live contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const first = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const held = await client.query(
        `select unit_id from public.contract_units where contract_id = $1`,
        [first.contractId],
      );
      const second = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
           values ($1, $2, 100, 2)`,
          [second.contractId, held.rows[0].unit_id],
        ),
      );
      expect(message).toMatch(/one_active_contract_per_unit/);
    });
  });

  it("releases the unit for uniqueness when the contract reaches a terminal state", async () => {
    await withRollback(async (client: PoolClient) => {
      const first = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const held = await client.query(
        `select unit_id from public.contract_units where contract_id = $1`,
        [first.contractId],
      );
      await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
        first.contractId,
      ]);
      const second = await seedContract(client, {
        startDate: "2027-01-01",
        endDate: "2027-12-31",
        state: "active",
      });
      // Must not raise.
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 100, 2)`,
        [second.contractId, held.rows[0].unit_id],
      );
      const count = await client.query(
        `select count(*)::int n from public.contract_units where contract_id = $1`,
        [second.contractId],
      );
      expect(count.rows[0].n).toBe(2);
    });
  });

  /**
   * Final review I1. `occupies_unit` is not a business field — it is the only
   * thing carrying the double-booking constraint into this table, because a
   * partial-index predicate cannot reach `contracts.state` in another table.
   *
   * Migration 110 seeded it with a trigger scoped to
   * `before insert or update OF contract_id`, and granted table-wide UPDATE to
   * `authenticated`. So a plain `update contract_units set occupies_unit =
   * false` — one PostgREST PATCH for any staff user with contracts.update —
   * dropped the row out of `one_active_contract_per_unit` and let a second
   * live contract onto the unit. Migration 119 widens the trigger to every
   * UPDATE, which makes the column unforgeable rather than merely ungranted.
   */
  it("re-derives occupies_unit on a direct write, so the double-booking guard cannot be switched off", async () => {
    await withRollback(async (client: PoolClient) => {
      const first = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const held = await client.query(
        `select unit_id, occupies_unit from public.contract_units where contract_id = $1`,
        [first.contractId],
      );
      expect(held.rows[0].occupies_unit).toBe(true);
      const heldUnitId = held.rows[0].unit_id;

      // The attack, exactly as the review ran it: write the column directly.
      // It succeeds as a statement — the trigger silently re-derives the value
      // rather than raising, which is what keeps the RPC's own writes working.
      await client.query(
        `update public.contract_units set occupies_unit = false where contract_id = $1`,
        [first.contractId],
      );
      const tampered = await client.query(
        `select occupies_unit from public.contract_units where contract_id = $1`,
        [first.contractId],
      );
      expect(tampered.rows[0].occupies_unit).toBe(true);

      // …and the index therefore still refuses a second live contract, even
      // when the insert itself tries to opt out of the predicate.
      const second = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.contract_units
             (contract_id, unit_id, monthly_amount, line_order, occupies_unit)
           values ($1, $2, 100, 2, false)`,
          [second.contractId, heldUnitId],
        ),
      );
      expect(message).toMatch(/one_active_contract_per_unit/);
    });
  });

  /**
   * Final review M2. `tg_contract_units_sync_total` resolved its target as
   * `coalesce(new.contract_id, old.contract_id)`, which on a re-parenting
   * UPDATE names the destination only — the source contract kept the departed
   * unit's rent in its displayed `monthly_amount` forever. Migration 119
   * recomputes both sides.
   */
  it("recomputes both contracts' totals when a unit row is re-parented", async () => {
    await withRollback(async (client: PoolClient) => {
      const source = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 300 }],
      });
      const destination = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        units: [{ monthlyAmount: 100 }],
      });

      await client.query(
        `update public.contract_units set contract_id = $1
          where contract_id = $2 and line_order = 2`,
        [destination.contractId, source.contractId],
      );

      const totals = await client.query(
        `select id, monthly_amount from public.contracts where id = any($1::uuid[])`,
        [[source.contractId, destination.contractId]],
      );
      const byId = new Map(totals.rows.map((r) => [r.id, Number(r.monthly_amount)]));
      // The defect: the source kept 700 because only the destination was recomputed.
      expect(byId.get(source.contractId)).toBe(400);
      expect(byId.get(destination.contractId)).toBe(400);
    });
  });

  it("gave every contract seeded by migration 11 exactly one unit", async () => {
    await withRollback(async (client: PoolClient) => {
      const orphans = await client.query(
        `select c.id from public.contracts c
          where not exists (select 1 from public.contract_units cu where cu.contract_id = c.id)`,
      );
      expect(orphans.rowCount).toBe(0);
    });
  });
});
