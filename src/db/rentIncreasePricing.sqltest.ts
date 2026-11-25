import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 196 — one rent increase per contract, effective from the
 * anniversary. Percent scales each unit; fixed is split by largest remainder
 * in fils so every share is non-negative and lines sum to the header.
 */

/**
 * تضبط الزيادة على العقد مباشرة (تتجاوز قفل الحفظ لغرض اختبار المسرّع).
 */
async function setIncrease(
  client: PoolClient,
  contractId: string,
  years: number,
  type: string,
  value: number,
) {
  await client.query(
    `update public.contracts set increase_after_years = $2, increase_type = $3, increase_value = $4 where id = $1`,
    [contractId, years, type, value],
  );
}

/**
 * مبالغ الوحدات في فترة معيّنة بترتيب السطر.
 */
async function unitAmounts(client: PoolClient, contractId: string, period: string) {
  const { rows } = await client.query<{ monthly_amount: string }>(
    `select monthly_amount from public.contract_unit_period_amounts($1, $2::date) order by line_order`,
    [contractId, period],
  );
  return rows.map((r) => Number(r.monthly_amount));
}

describe("contract_unit_period_amounts", () => {
  test("no increase: base rent every period", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-02-01",
        endDate: "2030-01-31",
        units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }],
      });
      expect(await unitAmounts(client, fx.contractId, "2028-06-01")).toEqual([300, 200]);
    });
  });

  test("percent applies from the anniversary month, not before", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-02-01",
        endDate: "2030-01-31",
        units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }],
      });
      await setIncrease(client, fx.contractId, 2, "percent", 10);
      expect(await unitAmounts(client, fx.contractId, "2027-01-01")).toEqual([300, 200]);
      expect(await unitAmounts(client, fx.contractId, "2027-02-01")).toEqual([330, 220]);
    });
  });

  test("fixed is split by largest remainder and the lines sum exactly", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-02-01",
        endDate: "2030-01-31",
        units: [{ monthlyAmount: 100 }, { monthlyAmount: 100 }, { monthlyAmount: 100 }],
      });
      await setIncrease(client, fx.contractId, 1, "fixed", 100);
      const amounts = await unitAmounts(client, fx.contractId, "2026-02-01");
      expect(amounts.reduce((a, b) => a + b, 0)).toBeCloseTo(400, 3);
      expect(amounts).toEqual([133.334, 133.333, 133.333]);
    });
  });

  test("a tiny fixed increase over many units never goes negative", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-02-01",
        endDate: "2030-01-31",
        units: Array.from({ length: 6 }, () => ({ monthlyAmount: 0.001 })),
      });
      await setIncrease(client, fx.contractId, 1, "fixed", 0.003);
      const amounts = await unitAmounts(client, fx.contractId, "2026-02-01");
      for (const amount of amounts) expect(amount).toBeGreaterThanOrEqual(0.001);
      expect(amounts.reduce((a, b) => a + b, 0)).toBeCloseTo(0.009, 3);
    });
  });

  test("contract_period_amounts carries the increase into the subtotal", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-02-01",
        endDate: "2030-01-31",
        monthlyAmount: 500,
      });
      await setIncrease(client, fx.contractId, 1, "percent", 20);
      const { rows } = await client.query<{ subtotal: string }>(
        `select subtotal from public.contract_period_amounts($1, '2026-02-01'::date)`,
        [fx.contractId],
      );
      expect(Number(rows[0].subtotal)).toBe(600);
    });
  });

  test.each([
    "increase_after_years = 1",
    "increase_type = 'percent'",
    "increase_value = 10",
    "increase_after_years = 1, increase_type = 'percent'",
    "increase_after_years = 1, increase_value = 10",
    "increase_type = 'percent', increase_value = 10",
  ])("the check constraint rejects a partial increase (%s)", async (assignment) => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-02-01", endDate: "2030-01-31" });
      await expect(
        client.query(`update public.contracts set ${assignment} where id = $1`, [fx.contractId]),
      ).rejects.toThrow(/contracts_increase_all_or_none/);
    });
  });
});

/**
 * إجماليات الفواتير مع مجموع البنود غير الإضافية لمقارنتها بالترويسة.
 */
async function invoiceTotals(client: PoolClient, contractId: string, year: number) {
  const { rows } = await client.query<{ period_month: number; subtotal: string; lines: string }>(
    `select i.period_month, i.subtotal,
            (select sum(amount) from public.invoice_items it where it.invoice_id = i.id and not it.is_extra_charge) as lines
       from public.invoices i where i.contract_id = $1 and i.period_year = $2 order by i.period_month`,
    [contractId, year],
  );
  return rows.map((r) => ({
    month: r.period_month,
    subtotal: Number(r.subtotal),
    lines: Number(r.lines),
  }));
}

describe("generate_invoices_for_year with an increase", () => {
  test("future invoices on/after the anniversary carry the increase and lines equal the header", async () => {
    await withRollback(async (client) => {
      // Two years ahead so every month is FUTURE: p_include_past=false is the
      // explicit-Generate path and the only one that emits future periods.
      const fx = await seedContract(client, {
        startDate: "2028-02-01",
        endDate: "2030-01-31",
        units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }],
      });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [
        fx.contractId,
      ]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 1)!.subtotal).toBe(500);
      expect(rows.find((r) => r.month === 2)!.subtotal).toBe(550);
      for (const row of rows) expect(row.lines).toBe(row.subtotal);
    });
  });
});

describe("regenerate_contract_invoices with an increase", () => {
  test("reprices unpaid future invoices after the anniversary and leaves paid ones", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2028-02-01",
        endDate: "2030-01-31",
        monthlyAmount: 500,
      });
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [
        fx.contractId,
      ]);
      await client.query(
        `update public.invoices set state='paid', paid=total where contract_id=$1 and period_year=2029 and period_month=1`,
        [fx.contractId],
      );
      await setIncrease(client, fx.contractId, 1, "fixed", 50);
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [fx.contractId]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 1)!.subtotal).toBe(500);
      expect(rows.find((r) => r.month === 2)!.subtotal).toBe(550);
      expect(rows.find((r) => r.month === 6)!.subtotal).toBe(550);
      for (const row of rows) if (row.month !== 1) expect(row.lines).toBe(row.subtotal);
    });
  });
});

describe("sync_contract_invoice_schedule with an increase", () => {
  test("reprices existing future invoices and fills a missing month with the increase; lines equal header", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2028-02-01",
        endDate: "2030-01-31",
        monthlyAmount: 500,
      });
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [
        fx.contractId,
      ]);
      await client.query(
        `delete from public.invoice_items where invoice_id in (select id from public.invoices where contract_id=$1 and period_year=2029 and period_month=5)`,
        [fx.contractId],
      );
      await client.query(
        `delete from public.invoices where contract_id=$1 and period_year=2029 and period_month=5`,
        [fx.contractId],
      );
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [
        fx.contractId,
      ]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 2)!.subtotal).toBe(550);
      expect(rows.find((r) => r.month === 5)!.subtotal).toBe(550);
      for (const row of rows) expect(row.lines).toBe(row.subtotal);
    });
  });
});

/**
 * مستخدم إداري لاستدعاء دالة الحفظ التي تفرض الصلاحيات.
 *
 * `save_contract_with_units` checks `has_permission(auth.uid(), ...)`
 * unconditionally, so the pool's own role (with a null auth.uid()) is
 * refused — the call must adopt a real identity holding contracts.create /
 * contracts.update, the same setup the neighbouring save-RPC tests use.
 */
async function seedAdmin(client: PoolClient): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, 'admin'::public.app_role)`,
    [userId],
  );
  await client.query(
    `insert into public.profiles (id, email, display_name, is_active)
     values ($1, $2, 'Increase Admin', true)
     on conflict (id) do nothing`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

/**
 * يتبنّى هوية إدارية قبل استدعاء دالة الحفظ.
 */
async function asContractsAdmin(client: PoolClient): Promise<void> {
  await actAs(client, "authenticated", await seedAdmin(client));
}

/**
 * يستدعي دالة الحفظ لوحدة واحدة ويرجع معرّف العقد.
 *
 * `from fn(...) as c`, not `select (fn(...)).id`: expanding a composite
 * result in the target list can re-evaluate a volatile function, while the
 * FROM form calls it exactly once (see saveContractWithUnits.sqltest.ts).
 */
async function saveRpc(
  client: PoolClient,
  contract: Record<string, unknown>,
  unitId: string,
  contractId: string | null,
) {
  const { rows } = await client.query<{ id: string }>(
    `select c.id as id from public.save_contract_with_units($1::jsonb, $2::jsonb, $3::uuid) as c`,
    [
      JSON.stringify(contract),
      JSON.stringify([{ unit_id: unitId, monthly_amount: 500 }]),
      contractId,
    ],
  );
  return rows[0].id;
}

describe("save_contract_with_units increase", () => {
  test("a true create stores the trio", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      // The seeded contract already occupies fx.unitId
      // (one_active_contract_per_unit), so the created contract takes a fresh
      // unit on the same property.
      const extra = await client.query<{ id: string }>(
        `insert into public.units (code, property_id, name) values ('U-' || substr(gen_random_uuid()::text, 1, 8), $1, 'Extra') returning id`,
        [fx.propertyId],
      );
      await asContractsAdmin(client);
      const id = await saveRpc(
        client,
        {
          tenant_id: fx.tenantId,
          start_date: "2028-02-01",
          end_date: "2030-01-31",
          duration_months: 24,
          increase_after_years: 1,
          increase_type: "percent",
          increase_value: 10,
        },
        extra.rows[0].id,
        null,
      );
      await actAsSuperuser(client);
      const saved = await client.query(
        `select increase_after_years, increase_type, increase_value from public.contracts where id=$1`,
        [id],
      );
      expect(saved.rows[0]).toMatchObject({ increase_after_years: 1, increase_type: "percent" });
      expect(Number(saved.rows[0].increase_value)).toBe(10);
    });
  });

  test("absent keys preserve, explicit null clears, unchanged patch never raises", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await asContractsAdmin(client);
      const untouched = await captureRaise(client, () =>
        saveRpc(client, { notes: "x" }, fx.unitId, fx.contractId),
      );
      expect(untouched).toBeNull();
      let row = await client.query(`select increase_type from public.contracts where id=$1`, [
        fx.contractId,
      ]);
      expect(row.rows[0].increase_type).toBe("percent");
      const unchanged = await captureRaise(client, () =>
        saveRpc(
          client,
          { increase_after_years: 1, increase_type: "percent", increase_value: 10 },
          fx.unitId,
          fx.contractId,
        ),
      );
      expect(unchanged).toBeNull();
      const cleared = await captureRaise(client, () =>
        saveRpc(
          client,
          { increase_after_years: null, increase_type: null, increase_value: null },
          fx.unitId,
          fx.contractId,
        ),
      );
      expect(cleared).toBeNull();
      await actAsSuperuser(client);
      row = await client.query(`select increase_type from public.contracts where id=$1`, [
        fx.contractId,
      ]);
      expect(row.rows[0].increase_type).toBeNull();
    });
  });

  test("refuses a change once a post-anniversary invoice carries money, including overdue partials", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [
        fx.contractId,
      ]);
      await client.query(
        `update public.invoices set state='overdue', paid=100 where contract_id=$1 and period_year=2029 and period_month=6`,
        [fx.contractId],
      );
      await asContractsAdmin(client);
      const change = await captureRaise(client, () =>
        saveRpc(client, { increase_value: 15 }, fx.unitId, fx.contractId),
      );
      expect(change).toMatch(/Rent increase is locked/);
      const clear = await captureRaise(client, () =>
        saveRpc(
          client,
          { increase_after_years: null, increase_type: null, increase_value: null },
          fx.unitId,
          fx.contractId,
        ),
      );
      expect(clear).toMatch(/Rent increase is locked/);
      const moveStart = await captureRaise(client, () =>
        saveRpc(client, { start_date: "2028-01-01" }, fx.unitId, fx.contractId),
      );
      expect(moveStart).toMatch(/Rent increase is locked/);
    });
  });

  test("clearing an unlocked increase and syncing reprices back", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2028-02-01",
        endDate: "2030-01-31",
        monthlyAmount: 500,
      });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [
        fx.contractId,
      ]);
      await asContractsAdmin(client);
      const cleared = await captureRaise(client, () =>
        saveRpc(
          client,
          { increase_after_years: null, increase_type: null, increase_value: null },
          fx.unitId,
          fx.contractId,
        ),
      );
      expect(cleared).toBeNull();
      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [
        fx.contractId,
      ]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 6)!.subtotal).toBe(500);
      expect(rows.find((r) => r.month === 6)!.lines).toBe(500);
    });
  });
});

describe("save_contract_with_units increase lock boundaries", () => {
  test("the first increase on a contract with a paid post-anniversary invoice is accepted", async () => {
    await withRollback(async (client) => {
      // CON-00026's shape: the increase lived in free text for two years while
      // invoices were paid. Recording it must not be refused; paid rows are
      // never repriced anyway.
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [
        fx.contractId,
      ]);
      await client.query(
        `update public.invoices set state='paid', paid=total where contract_id=$1 and period_year=2029 and period_month=6`,
        [fx.contractId],
      );
      await asContractsAdmin(client);
      const first = await captureRaise(client, () =>
        saveRpc(
          client,
          { increase_after_years: 1, increase_type: "percent", increase_value: 15 },
          fx.unitId,
          fx.contractId,
        ),
      );
      expect(first).toBeNull();
      await actAsSuperuser(client);
      const row = await client.query(`select increase_value from public.contracts where id=$1`, [
        fx.contractId,
      ]);
      expect(Number(row.rows[0].increase_value)).toBe(15);
    });
  });

  test("a paid invoice strictly before the effective period does not lock", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [
        fx.contractId,
      ]);
      // 2029-01 is the last pre-anniversary month (effective 2029-02).
      await client.query(
        `update public.invoices set state='paid', paid=total where contract_id=$1 and period_year=2029 and period_month=1`,
        [fx.contractId],
      );
      await asContractsAdmin(client);
      const change = await captureRaise(client, () =>
        saveRpc(client, { increase_value: 15 }, fx.unitId, fx.contractId),
      );
      expect(change).toBeNull();
    });
  });
});

describe("contract_unit_period_amounts grants", () => {
  test("neither anon nor authenticated can execute the pricer directly", async () => {
    await withRollback(async (client) => {
      // A portal tenant could otherwise pass any contract id and read another
      // tenant's per-unit rents; only the SECURITY DEFINER invoice functions
      // (running as owner) and service_role may call it.
      const { rows } = await client.query<{ role: string; can: boolean }>(
        `select r.role, has_function_privilege(r.role, 'public.contract_unit_period_amounts(uuid, date)', 'EXECUTE') as can
           from (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.role, r.can]))).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
    });
  });
});
