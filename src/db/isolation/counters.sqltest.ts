import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * دوال الترقيم المتسلسل لكل شركة وأول رمز متوقع لكل منها.
 */
const SEQUENTIAL_CODE_GENERATORS = [
  { fn: "next_invoice_code", kind: "invoice", first: "INV-0000001", second: "INV-0000002" },
  { fn: "next_payment_code", kind: "payment", first: "PAY-0000001", second: "PAY-0000002" },
  { fn: "next_contract_code", kind: "contract", first: "CON-00001", second: "CON-00002" },
  { fn: "next_refund_code", kind: "refund", first: "REF-0000001", second: "REF-0000002" },
  { fn: "next_property_code", kind: "property", first: "PROP-001", second: "PROP-002" },
  { fn: "next_building_code", kind: "building", first: "BLDG-00001", second: "BLDG-00002" },
  { fn: "next_unit_code", kind: "unit", first: "UNIT-00001", second: "UNIT-00002" },
  { fn: "next_tenant_code", kind: "tenant", first: "DANA-000001", second: "DANA-000002" },
  {
    fn: "next_payment_request_code",
    kind: "payment_request",
    first: "PREQ-0000001",
    second: "PREQ-0000002",
  },
  { fn: "next_expense_code", kind: "expense", first: "EXP-000001", second: "EXP-000002" },
  { fn: "next_deposit_code", kind: "deposit", first: "DEP-000001", second: "DEP-000002" },
  {
    fn: "next_electricity_charge_code",
    kind: "electricity_charge",
    first: "ELEC-0000001",
    second: "ELEC-0000002",
  },
  { fn: "next_employee_code", kind: "employee", first: "EMP-00001", second: "EMP-00002" },
  {
    fn: "next_maintenance_request_code",
    kind: "maintenance_request",
    first: "MNT-000001",
    second: "MNT-000002",
  },
] as const;

/**
 * يستدعي دالة توليد الرمز في قاعدة البيانات ويعيد النص المُولَّد.
 */
async function callNextCode(client: PoolClient, fnName: string): Promise<string> {
  const { rows } = await client.query<{ code: string }>(`select public.${fnName}() as code`);
  return rows[0].code;
}

describe("per-company document numbering via company_counters (T019)", () => {
  test("company_counters exists with (company_id, kind) primary key and forced RLS", async () => {
    await withRollback(async (client) => {
      const { rows: tableRows } = await client.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select c.relrowsecurity, c.relforcerowsecurity
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'company_counters'`,
      );
      expect(tableRows).toHaveLength(1);
      expect(tableRows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const { rows: pkRows } = await client.query<{ cols: string[] }>(
        `select array_agg(a.attname::text order by k.pos) as cols
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace
           join unnest(con.conkey) with ordinality as k(attnum, pos) on true
           join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
          where n.nspname = 'public'
            and c.relname = 'company_counters'
            and con.contype = 'p'`,
      );
      expect(pkRows[0]?.cols).toEqual(["company_id", "kind"]);
    });
  });

  test("starts every sequential next_*_code() from 1 independently for companies A and B and fails closed without a company", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);

      for (const spec of SEQUENTIAL_CODE_GENERATORS) {
        await runAsCompanyService(client, A.id, async () => {
          expect(await callNextCode(client, spec.fn), `${spec.fn} A #1`).toBe(spec.first);
          expect(await callNextCode(client, spec.fn), `${spec.fn} A #2`).toBe(spec.second);
        });

        await runAsCompanyService(client, B.id, async () => {
          expect(await callNextCode(client, spec.fn), `${spec.fn} B #1`).toBe(spec.first);
        });

        await runAsCompanyService(client, null, async () => {
          const err = await captureRaise(client, () => callNextCode(client, spec.fn));
          expect(err, `${spec.fn} without company context must fail`).not.toBeNull();
        });
      }

      // Isolate counter rows per company.
      await runAsUser(client, A.users.admin, async () => {
        const { rows } = await client.query<{ company_id: string }>(
          `select distinct company_id from public.company_counters`,
        );
        expect(rows.map((r) => r.company_id)).toEqual([A.id]);
      });

      await runAsCompanyService(client, null, async () => {
        const { rows } = await client.query(`select company_id from public.company_counters`);
        expect(rows).toEqual([]);
      });
    });
  });

  test("next_receipt_code requires active company context and does not leak between companies", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);

      await runAsCompanyService(client, null, async () => {
        const err = await captureRaise(client, () => callNextCode(client, "next_receipt_code"));
        expect(err).not.toBeNull();
      });

      let receiptA = "";
      let receiptB = "";
      await runAsCompanyService(client, A.id, async () => {
        receiptA = await callNextCode(client, "next_receipt_code");
      });
      await runAsCompanyService(client, B.id, async () => {
        receiptB = await callNextCode(client, "next_receipt_code");
      });

      expect(receiptA).toMatch(/^REC-/);
      expect(receiptB).toMatch(/^REC-/);
      expect(receiptA).not.toBe(receiptB);
    });
  });
});
