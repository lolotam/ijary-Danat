import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  runAsCompanyService,
  runAsUser,
  seedTwoCompanies,
  setCompanyStatus,
} from "@/db/isolation/twoCompanies";
import { actAsSuperuser, captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/** استدعاء لدالة `SECURITY DEFINER` مفتوحة لأدوار الـ API، بمعاملات صالحة النوع. */
interface DefinerCall {
  name: string;
  sql: string;
}

/**
 * الدوال الـ 19 في الترحيلات 290–297 التي تمنح EXECUTE لـ `authenticated` و `company_service`.
 *
 * `$1` is a random id: every call must raise COMPANY_REQUIRED on entry, before
 * the id is ever looked up.
 */
const API_DEFINER_CALLS: DefinerCall[] = [
  {
    name: "apply_payment_allocation",
    sql: "select public.apply_payment_allocation($1::uuid, '[]'::jsonb)",
  },
  { name: "delete_contract_insurance", sql: "select public.delete_contract_insurance($1::uuid)" },
  {
    name: "edit_partial_payment",
    sql: "select public.edit_partial_payment($1::uuid, 1, current_date, null, null, null, null, null, null, null)",
  },
  {
    name: "get_invoice_payment_breakdown",
    sql: "select public.get_invoice_payment_breakdown($1::uuid)",
  },
  { name: "portal_hidden_payment_ids", sql: "select public.portal_hidden_payment_ids($1::uuid)" },
  { name: "portal_insurance_total", sql: "select public.portal_insurance_total($1::uuid, null)" },
  { name: "reverse_payment", sql: "select public.reverse_payment($1::uuid, 'test')" },
  { name: "reverse_refund", sql: "select public.reverse_refund($1::uuid, 'test')" },
  {
    name: "sync_contract_deposit_from_insurance",
    sql: "select public.sync_contract_deposit_from_insurance($1::uuid)",
  },
  { name: "void_refund", sql: "select public.void_refund($1::uuid, 'test')" },
  {
    name: "cancel_contract_closeout",
    sql: "select public.cancel_contract_closeout($1::uuid, 'test')",
  },
  {
    name: "closeout_compute_settlement",
    sql: "select public.closeout_compute_settlement($1::uuid, '[]'::jsonb, '[]'::jsonb, 0)",
  },
  {
    name: "close_out_contract",
    sql: `select public.close_out_contract($1::uuid, current_date, 'test', null, false,
            '[]'::jsonb, '[]'::jsonb, 0, null, null, null)`,
  },
  {
    name: "get_contract_closeout_preview",
    sql: "select public.get_contract_closeout_preview($1::uuid, '[]'::jsonb, '[]'::jsonb, 0)",
  },
  {
    name: "restore_contract",
    sql: "select public.restore_contract($1::uuid, 'test', false, null)",
  },
  {
    name: "compute_electricity_amount",
    sql: "select public.compute_electricity_amount($1::uuid, 1)",
  },
  {
    name: "generate_electricity_charges",
    sql: "select public.generate_electricity_charges(2026, 1, $1::uuid)",
  },
  {
    name: "generate_salaries_for_month",
    sql: "select public.generate_salaries_for_month(2026, 1) where $1::uuid is not null",
  },
];

/** دوال التسوية الداخلية التي لا تُستدعى إلا من دوال ومشغّلات أخرى. */
const INTERNAL_SETTLEMENT_FUNCTIONS = [
  "public.apply_deposit_settlement(uuid)",
  "public.apply_partial_payment_settlement(uuid)",
  "public.apply_partial_payment_settlement(uuid, boolean, boolean)",
  "public.revert_deposit_settlement(uuid)",
  "public.revert_partial_payment_settlement(uuid)",
] as const;

/**
 * يستدعي كل دالة في المصفوفة ويرجع الدوال التي لم ترفض بـ COMPANY_REQUIRED مع سبب كل منها.
 */
async function callsNotRefused(client: PoolClient): Promise<string[]> {
  const leaks: string[] = [];
  for (const call of API_DEFINER_CALLS) {
    const message = await captureRaise(client, () => client.query(call.sql, [randomUUID()]));
    if (message !== "COMPANY_REQUIRED") {
      leaks.push(`${call.name}: ${message ?? "returned without raising"}`);
    }
  }
  return leaks;
}

/**
 * يزرع عقداً وسجل تأمين له في الشركة المحددة ويرجع معرف العقد.
 */
async function seedInsuredContract(client: PoolClient, companyId: string): Promise<string> {
  const fixture = await seedContract(client, {
    companyId,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  });
  await actAsSuperuser(client);
  await client.query(
    `insert into public.insurance_payments (company_id, contract_id, tenant_id, unit_id, amount)
     values ($1, $2, $3, $4, 100)`,
    [companyId, fixture.contractId, fixture.tenantId, fixture.unitId],
  );
  return fixture.contractId;
}

// Regression (T052n, review 2026-11-26): inside SECURITY DEFINER `current_user`
// is the function owner, so every `current_user in ('authenticated', ...)` null
// guard in migrations 290-297 was dead and a caller with no company context ran
// these functions across every company.
describe("security definer RPCs refuse a null company context (T052n)", () => {
  test("a staff user whose profile is deactivated gets COMPANY_REQUIRED from all 19 RPCs", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      await client.query(`update public.profiles set is_active = false where id = $1`, [
        A.users.admin.id,
      ]);

      const leaks = await runAsUser(client, A.users.admin, () => callsNotRefused(client));
      expect(leaks).toEqual([]);
    });
  });

  test("a company_service token without a company_id claim gets COMPANY_REQUIRED from all 19 RPCs", async () => {
    await withRollback(async (client) => {
      const leaks = await runAsCompanyService(client, null, () => callsNotRefused(client));
      expect(leaks).toEqual([]);
    });
  });

  test("a company_service token for a suspended company gets COMPANY_REQUIRED from all 19 RPCs", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      await setCompanyStatus(client, A.id, "suspended");

      const leaks = await runAsCompanyService(client, A.id, () => callsNotRefused(client));
      expect(leaks).toEqual([]);
    });
  });

  test("receipt_html_for_payment does not render another company's receipt on a null context", async () => {
    await withRollback(async (client) => {
      const { B } = await seedTwoCompanies(client);
      const contractB = await seedContract(client, {
        companyId: B.id,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      // seedContract leaves B's company claim set, which the payment code
      // generator needs.
      const {
        rows: [payment],
      } = await client.query<{ id: string }>(
        `insert into public.payments (company_id, tenant_id, amount, method, status, payment_date)
         values ($1, $2, 100, 'cash', 'confirmed', current_date) returning id`,
        [B.id, contractB.tenantId],
      );

      const message = await runAsCompanyService(client, null, () =>
        captureRaise(client, () =>
          client.query(`select public.receipt_html_for_payment($1)`, [payment.id]),
        ),
      );
      expect(message).toBe("COMPANY_REQUIRED");
    });
  });
});

// Regression (T052n): the `insurance.delete` check in `delete_contract_insurance`
// also tested `current_user`, so any signed-in user could delete insurance.
describe("delete_contract_insurance enforces insurance.delete (T052n)", () => {
  test.each(["readonly", "tenant"] as const)(
    "a %s user cannot delete their own company's insurance",
    async (role) => {
      await withRollback(async (client) => {
        const { A } = await seedTwoCompanies(client);
        const contractId = await seedInsuredContract(client, A.id);

        const message = await runAsUser(client, A.users[role], () =>
          captureRaise(client, () =>
            client.query(`select public.delete_contract_insurance($1)`, [contractId]),
          ),
        );
        expect(message).toBe("insurance_delete_forbidden");

        const { rowCount } = await client.query(
          `select 1 from public.insurance_payments where contract_id = $1`,
          [contractId],
        );
        expect(rowCount).toBe(1);
      });
    },
  );

  test("an admin deletes their own company's insurance", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const contractId = await seedInsuredContract(client, A.id);

      const { rows } = await runAsUser(client, A.users.admin, () =>
        client.query<{ deleted: boolean }>(
          `select public.delete_contract_insurance($1) as deleted`,
          [contractId],
        ),
      );
      expect(rows[0].deleted).toBe(true);
    });
  });
});

// Regression (T052n): the internal settlement functions guarded API callers with
// `current_user`, which never matched, so the grant was the only barrier.
describe("internal settlement functions are closed to API roles (T052n)", () => {
  test("no API role holds EXECUTE on the internal settlement functions", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ grantee: string; fn: string }>(
        `select r.grantee, f.fn
           from unnest($1::text[]) as f(fn)
           cross join unnest(array['anon', 'authenticated', 'company_service', 'service_role']) as r(grantee)
          where has_function_privilege(r.grantee, f.fn::regprocedure, 'EXECUTE')
          order by 1, 2`,
        [[...INTERNAL_SETTLEMENT_FUNCTIONS]],
      );
      expect(rows).toEqual([]);
    });
  });
});
