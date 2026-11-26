import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migrations 113/114 — downstream readers of contract_units.
 *
 * Real SQL against a real Postgres built from db/migrations. Covers the two
 * functions outside the close-out family that used to read contracts.unit_id
 * directly (validate_electricity_charge_insert, migration 113) and the
 * close-out family's restore pre-flight, now that it must fan out over every
 * unit on a contract instead of a single column (migration 114). See
 * db/migrations/113_electricity_and_bulk_import.sql and
 * db/migrations/114_closeout_multi_unit.sql for the SQL under test.
 */

describe("validate_electricity_charge_insert reads contract_units", () => {
  test("a tenant-owned meter charge on the second unit of a multi-unit contract resolves to that contract's tenant", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });

      // Before migration 113, the trigger's tenant lookup joined
      // contracts.unit_id directly, so it could only ever see the contract's
      // FIRST unit. This meter sits on the SECOND unit (fixture.unitIds[1]) —
      // a lookup that still reads contracts.unit_id would find no contract at
      // all for it, and tenant_id would resolve to null instead of raising or
      // matching (v_tenant_id is null only raises when ownership is
      // tenant_owned and no contract matches; the point of this test is that
      // one DOES match, via contract_units).
      const tariff = await client.query<{ id: string }>(
        `insert into public.electricity_tariffs (code, name_ar, unit_price)
         values ($1, 'تعرفة اختبار', 0.5) returning id`,
        [`TAR-${randomUUID().slice(0, 8)}`],
      );

      const meter = await client.query<{ id: string }>(
        `insert into public.electricity_meters (unit_id, ownership, tariff_id)
         values ($1, 'tenant_owned', $2) returning id`,
        [fixture.unitIds[1], tariff.rows[0].id],
      );

      // meter_readings' own BEFORE INSERT trigger (compute_consumption,
      // 09_phase7_electricity.sql:101-137) unconditionally overwrites
      // consumption_kwh from `reading` minus the previous period's reading
      // (0 here, since this is the meter's first reading) — so it is not
      // passed explicitly; whatever value compute_electricity_amount derives
      // from it is irrelevant to what this test asserts (tenant resolution).
      const reading = await client.query<{ id: string }>(
        `insert into public.meter_readings
           (meter_id, reading, reading_date, period_year, period_month)
         values ($1, 100, '2026-03-05', 2026, 3)
         returning id`,
        [meter.rows[0].id],
      );

      const charge = await client.query<{ tenant_id: string | null; unit_id: string }>(
        `insert into public.electricity_charges (meter_id, unit_id, reading_id, period_year, period_month)
         values ($1, $2, $3, 2026, 3)
         returning tenant_id, unit_id`,
        [meter.rows[0].id, fixture.unitIds[1], reading.rows[0].id],
      );

      expect(charge.rows[0].tenant_id).toBe(fixture.tenantId);
      expect(charge.rows[0].unit_id).toBe(fixture.unitIds[1]);
    });
  });

  test("a tenant-owned meter with no matching contract still raises (unchanged guard)", async () => {
    // Regression guard: the contract_units rewrite must not turn the
    // "no active contract for the period" exception into a silent null.
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "draft", // not 'active' -> the tenant lookup matches nothing
      });

      const tariff = await client.query<{ id: string }>(
        `insert into public.electricity_tariffs (code, name_ar, unit_price)
         values ($1, 'تعرفة اختبار', 0.5) returning id`,
        [`TAR-${randomUUID().slice(0, 8)}`],
      );
      const meter = await client.query<{ id: string }>(
        `insert into public.electricity_meters (unit_id, ownership, tariff_id)
         values ($1, 'tenant_owned', $2) returning id`,
        [fixture.unitId, tariff.rows[0].id],
      );
      const reading = await client.query<{ id: string }>(
        `insert into public.meter_readings
           (meter_id, reading, reading_date, period_year, period_month)
         values ($1, 50, '2026-03-05', 2026, 3)
         returning id`,
        [meter.rows[0].id],
      );

      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.electricity_charges (meter_id, unit_id, reading_id, period_year, period_month)
           values ($1, $2, $3, 2026, 3)`,
          [meter.rows[0].id, fixture.unitId, reading.rows[0].id],
        ),
      );
      expect(message).toMatch(/no active contract for the charge period/i);
    });
  });
});

describe("restore_contract's pre-flight fans out over every unit on the contract", () => {
  test("restoring an archived multi-unit contract raises a readable error naming the unit another live contract now holds", async () => {
    await withRollback(async (client: PoolClient) => {
      const first = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(
        `update public.contracts set state = 'terminated', archived_at = now() where id = $1`,
        [first.contractId],
      );

      // A second, unrelated live contract picks up first's SECOND unit —
      // before migration 114, restore_contract's pre-flight only ever
      // compared against contracts.unit_id, so a conflict on any unit past
      // the first would go undetected (or worse, raise a raw 23505 from
      // one_active_contract_per_unit instead of this readable message).
      const second = await seedContract(client, {
        companyId: first.companyId,
        startDate: "2027-01-01",
        endDate: "2027-12-31",
        state: "active",
      });
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 300, 2)`,
        [second.contractId, first.unitIds[1]],
      );

      const message = await captureRaise(client, () =>
        client.query(
          `select public.restore_contract($1, 'terminated', false, 'multi-unit restore conflict test')`,
          [first.contractId],
        ),
      );
      expect(message).toMatch(/another live contract .* holds unit/i);
      expect(message).toContain(first.unitIds[1]);
    });
  });
});
