import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 111 — unit occupancy (migration 76) moves onto `contract_units`
 * (migration 110). Before this migration `unit_has_active_contract` read
 * `contracts.unit_id` directly, so a multi-unit contract only ever marked its
 * first unit occupied; every other unit on the contract stayed `vacant` no
 * matter what the contract's state was.
 */

describe("unit occupancy from contract_units", () => {
  test("marks every unit on the contract occupied, and all of them vacant on termination", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });

      let statuses = await client.query(
        `select status from public.units where id = any($1::uuid[]) order by status`,
        [fixture.unitIds],
      );
      expect(statuses.rows.map((r) => r.status)).toEqual(["occupied", "occupied"]);

      await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
        fixture.contractId,
      ]);
      statuses = await client.query(
        `select status from public.units where id = any($1::uuid[]) order by status`,
        [fixture.unitIds],
      );
      expect(statuses.rows.map((r) => r.status)).toEqual(["vacant", "vacant"]);
    });
  });

  test("frees only the removed unit when one is taken off the contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(
        `delete from public.contract_units where contract_id = $1 and line_order = 2`,
        [fixture.contractId],
      );
      const statuses = await client.query(
        `select u.id, u.status from public.units u where u.id = any($1::uuid[])`,
        [fixture.unitIds],
      );
      const byId = new Map(statuses.rows.map((r) => [r.id, r.status]));
      expect(byId.get(fixture.unitIds[0])).toBe("occupied");
      expect(byId.get(fixture.unitIds[1])).toBe("vacant");
    });
  });

  test("treats an archived contract as releasing its units", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        fixture.contractId,
      ]);
      const statuses = await client.query(
        `select status from public.units where id = any($1::uuid[])`,
        [fixture.unitIds],
      );
      expect(statuses.rows.every((r) => r.status === "vacant")).toBe(true);
    });
  });
});
