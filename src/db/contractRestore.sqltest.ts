import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedCompanyUser,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 87 — restore_contract.
 *
 * Restore clears archived_at and optionally re-enables the tenant/portal.
 * It is NOT lease reactivation and must never regenerate invoices.
 */

/** ينشئ شركة اختبار جديدة ويعيد معرّفها. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  return rows[0].id;
}

/** ينشئ مستخدماً إدارياً ضمن الشركة المحددة. */
async function seedAdmin(client: PoolClient, companyId: string): Promise<string> {
  return seedCompanyUser(client, companyId, "admin", "restore-admin");
}

async function seedInsurance(
  client: PoolClient,
  opts: { contractId: string; tenantId: string; unitId: string; companyId: string; amount: number },
): Promise<void> {
  await client.query(
    `insert into public.insurance_payments
       (company_id, contract_id, tenant_id, unit_id, amount, collected_date)
     values ($1, $2, $3, $4, $5, current_date)`,
    [opts.companyId, opts.contractId, opts.tenantId, opts.unitId, opts.amount],
  );
}

/** ينفّذ الدالة بصلاحية مدير ضمن شركة محددة ثم يعيد صلاحية المشرف. */
async function asAdmin<T>(
  client: PoolClient,
  fn: (adminId: string, companyId: string) => Promise<T>,
  existingCompanyId?: string,
): Promise<T> {
  const companyId = existingCompanyId ?? (await seedCompany(client));
  const adminId = await seedAdmin(client, companyId);
  await actAs(client, "authenticated", adminId);
  try {
    return await fn(adminId, companyId);
  } finally {
    await actAsSuperuser(client);
  }
}

async function archiveViaCloseOut(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{ result: Record<string, unknown> }>(
    `select public.close_out_contract(
       $1::uuid, current_date, 'archive', 'terminated', false,
       '[]'::jsonb, '[]'::jsonb, null, 'archive for restore test',
       $2, null
     ) as result`,
    [contractId, `idem-${randomUUID()}`],
  );
  return rows[0].result;
}

describe("restore_contract", () => {
  test("26. restore un-archives, sets target state, re-occupies unit via trigger", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 100,
        });
        await archiveViaCloseOut(client, fx.contractId);

        const mid = await client.query<{
          state: string;
          archived_at: string | null;
          status: string;
        }>(
          `select c.state::text, c.archived_at, u.status::text as status
             from public.contracts c
             join public.contract_units cu on cu.contract_id = c.id
             join public.units u on u.id = cu.unit_id
            where c.id = $1`,
          [fx.contractId],
        );
        expect(mid.rows[0].archived_at).not.toBeNull();
        expect(mid.rows[0].status).toBe("vacant");

        const { rows } = await client.query<{ result: Record<string, unknown> }>(
          `select public.restore_contract($1, 'active', false, 'tenant returning early') as result`,
          [fx.contractId],
        );
        expect(rows[0].result.contract_state).toBe("active");
        expect(rows[0].result.archived_at).toBeNull();
        expect(rows[0].result.unit_status).toBe("occupied");

        const after = await client.query<{
          state: string;
          archived_at: string | null;
          status: string;
        }>(
          `select c.state::text, c.archived_at, u.status::text as status
             from public.contracts c
             join public.contract_units cu on cu.contract_id = c.id
             join public.units u on u.id = cu.unit_id
            where c.id = $1`,
          [fx.contractId],
        );
        expect(after.rows[0].state).toBe("active");
        expect(after.rows[0].archived_at).toBeNull();
        expect(after.rows[0].status).toBe("occupied");
      });
    });
  });

  // Migration 142 moved this from the account flag to the portal flag, and
  // deleted restore_contract's unconditional `set is_active = true` — which
  // would otherwise silently re-activate an account an admin had deliberately
  // deactivated. The restore brings the PORTAL back; the account is never
  // touched in either direction.
  test("27. restore re-enables the tenant portal and leaves the account alone", async () => {
    await withRollback(async (client) => {
      // Seed portal auth.users while still superuser — authenticated cannot insert there.
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const portalUser = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
        [portalUser, `${portalUser}@tenant.test`],
      );
      // handle_new_user already inserted a profiles row — attach it to the
      // tenant and deactivate it, standing in for an admin who switched this
      // person off deliberately. Starting from `true` would make the assertion
      // below vacuous: re-adding the `set is_active = true` that migration 142
      // deleted would still leave an already-active account active, and the
      // test would pass while the regression shipped.
      await client.query(
        `update public.profiles
            set tenant_id = $2, email = $3, is_active = false
          where id = $1`,
        [portalUser, fx.tenantId, `${portalUser}@tenant.test`],
      );
      await seedInsurance(client, {
        contractId: fx.contractId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        companyId: fx.companyId,
        amount: 80,
      });

      await asAdmin(
        client,
        async () => {
          await archiveViaCloseOut(client, fx.contractId);

          const mid = await client.query<{ tenant_portal_enabled: boolean }>(
            `select tenant_portal_enabled from public.tenants where id = $1`,
            [fx.tenantId],
          );
          expect(mid.rows[0].tenant_portal_enabled).toBe(false);

          await client.query(
            `select public.restore_contract($1, 'terminated', true, 'restore portal access')`,
            [fx.contractId],
          );

          const after = await client.query<{ tenant_portal_enabled: boolean }>(
            `select tenant_portal_enabled from public.tenants where id = $1`,
            [fx.tenantId],
          );
          expect(after.rows[0].tenant_portal_enabled).toBe(true);

          // Still off. This is the deactivation an admin made on purpose, and
          // migration 142 exists to stop restore_contract silently undoing it —
          // which would also desync the flag from GoTrue's `banned_until`, so the
          // Users table would read "active" while the login stayed refused.
          const account = await client.query<{ is_active: boolean }>(
            `select is_active from public.profiles where id = $1`,
            [portalUser],
          );
          expect(account.rows[0].is_active).toBe(false);
        },
        fx.companyId,
      );
    });
  });

  test("28. restore raises when another live contract holds the unit", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 70,
        });
        await archiveViaCloseOut(client, fx.contractId);

        // New live contract on the same unit.
        const tag = randomUUID().slice(0, 8);
        const tenant = await client.query<{ id: string }>(
          `insert into public.tenants (code, company_id, name)
           values ($1, $2, $3) returning id`,
          [`T2-${tag}`, fx.companyId, `Tenant ${tag}`],
        );
        const conflicting = await client.query<{ id: string }>(
          `insert into public.contracts
             (company_id, code, tenant_id, start_date, end_date, monthly_amount, state)
           values ($1, $2, $3, '2026-07-01', '2027-06-30', 400, 'active')
           returning id`,
          [fx.companyId, `C2-${tag}`, tenant.rows[0].id],
        );
        // Migration 114: close-out/restore now read contract_units, not
        // contracts.unit_id — a contract inserted only with the raw column
        // (as above) would otherwise have no units at all as far as
        // restore_contract's pre-flight is concerned.
        await client.query(
          `insert into public.contract_units (company_id, contract_id, unit_id, monthly_amount, line_order)
           values ($1, $2, $3, 400, 1)`,
          [fx.companyId, conflicting.rows[0].id, fx.unitId],
        );

        expect(
          await captureRaise(client, () =>
            client.query(`select public.restore_contract($1, 'terminated', false, 'should fail')`, [
              fx.contractId,
            ]),
          ),
        ).toMatch(/another live contract/i);
      });
    });
  });

  test("29. restore with blank reason raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 60,
        });
        await archiveViaCloseOut(client, fx.contractId);

        expect(
          await captureRaise(client, () =>
            client.query(`select public.restore_contract($1, 'terminated', false, '   ')`, [
              fx.contractId,
            ]),
          ),
        ).toMatch(/restore reason is required/i);
      });
    });
  });

  test("30. restore creates NO invoice", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 90,
        });
        await archiveViaCloseOut(client, fx.contractId);

        const before = await client.query(
          `select count(*)::int as n from public.invoices where contract_id = $1`,
          [fx.contractId],
        );

        await client.query(
          `select public.restore_contract($1, 'active', false, 'visibility only')`,
          [fx.contractId],
        );

        const after = await client.query(
          `select count(*)::int as n from public.invoices where contract_id = $1`,
          [fx.contractId],
        );
        expect(after.rows[0].n).toBe(before.rows[0].n);
      });
    });
  });

  test("31. restore preserves the close-out row and its child rows", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 250,
        });
        const inv = await client.query<{ id: string }>(
          `insert into public.invoices (
             company_id, contract_id, tenant_id, unit_id,
             period_year, period_month, issue_date, due_date,
             subtotal, total, paid, state, idempotency_key
           ) values (
             $1, $2, $3, $4, 2026, 3, '2026-03-01', '2026-03-05',
             75, 75, 0, 'due', $5
           ) returning id`,
          [fx.companyId, fx.contractId, fx.tenantId, fx.unitId, `inv-${randomUUID()}`],
        );

        const result = await client.query<{ result: { closeout_id: string } }>(
          `select public.close_out_contract(
             $1::uuid, current_date, 'archive', 'terminated', false,
             $2::jsonb, $3::jsonb, null, 'with children', $4, null
           ) as result`,
          [
            fx.contractId,
            JSON.stringify([
              { kind: "cleaning", amount: 10, description_en: "Clean", description_ar: "نظافة" },
            ]),
            JSON.stringify([{ invoice_id: inv.rows[0].id, action: "write_off", amount: 0 }]),
            `idem-${randomUUID()}`,
          ],
        );
        const closeoutId = result.rows[0].result.closeout_id;

        const deductionsBefore = await client.query(
          `select id from public.contract_closeout_deductions where closeout_id = $1`,
          [closeoutId],
        );
        const actionsBefore = await client.query(
          `select id from public.contract_closeout_invoice_actions where closeout_id = $1`,
          [closeoutId],
        );
        expect(deductionsBefore.rows).toHaveLength(1);
        expect(actionsBefore.rows).toHaveLength(1);

        await client.query(
          `select public.restore_contract($1, 'terminated', false, 'keep history')`,
          [fx.contractId],
        );

        const closeoutAfter = await client.query(
          `select id, status from public.contract_closeouts where id = $1`,
          [closeoutId],
        );
        expect(closeoutAfter.rows).toHaveLength(1);
        expect(closeoutAfter.rows[0].status).toBe("completed");

        const deductionsAfter = await client.query(
          `select id from public.contract_closeout_deductions where closeout_id = $1`,
          [closeoutId],
        );
        const actionsAfter = await client.query(
          `select id from public.contract_closeout_invoice_actions where closeout_id = $1`,
          [closeoutId],
        );
        expect(deductionsAfter.rows).toHaveLength(deductionsBefore.rows.length);
        expect(actionsAfter.rows).toHaveLength(actionsBefore.rows.length);
      });
    });
  });
});
