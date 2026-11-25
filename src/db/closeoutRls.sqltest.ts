import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Contract close-out schema — RLS, grants, and table CHECKs.
 *
 * Nothing in the app calls these tables yet. These tests prove the foundation
 * (migrations 83–84) cannot be misused by anon, by staff without the right
 * permission, or by bad data that slips past the UI.
 */

const TABLES = [
  "contract_closeouts",
  "contract_closeout_deductions",
  "contract_closeout_invoice_actions",
  "contract_operational_events",
] as const;

async function seedUserWithRole(client: PoolClient, role: string): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );
  return userId;
}

/** Minimal draft close-out row; caller supplies contract/tenant from seedContract. */
async function insertDraftCloseout(
  client: PoolClient,
  opts: {
    contractId: string;
    tenantId: string;
    outcome?: string;
    finalState?: string;
    archiveTenant?: boolean;
    status?: string;
    completedBy?: string | null;
    completedAt?: string | null;
    cancelledBy?: string | null;
    cancelledAt?: string | null;
    idempotencyKey?: string;
  },
): Promise<string> {
  const {
    contractId,
    tenantId,
    outcome = "keep_terminated",
    finalState = "terminated",
    archiveTenant = false,
    status = "draft",
    completedBy = null,
    completedAt = null,
    cancelledBy = null,
    cancelledAt = null,
    idempotencyKey = randomUUID(),
  } = opts;

  const { rows } = await client.query<{ id: string }>(
    `insert into public.contract_closeouts
       (contract_id, tenant_id, status, outcome, final_contract_state,
        archive_tenant, move_out_date, idempotency_key,
        completed_by, completed_at, cancelled_by, cancelled_at)
     values
       ($1, $2, $3, $4, $5::public.contract_states,
        $6, current_date, $7,
        $8, $9::timestamptz, $10, $11::timestamptz)
     returning id`,
    [
      contractId,
      tenantId,
      status,
      outcome,
      finalState,
      archiveTenant,
      idempotencyKey,
      completedBy,
      completedAt,
      cancelledBy,
      cancelledAt,
    ],
  );
  return rows[0].id;
}

describe("close-out grants close migration 56's anon omission", () => {
  test.each([...TABLES])("anon cannot select from %s", async (table) => {
    // Tables that only revoked from public left anon holding SELECT from
    // Supabase default privileges (migration 78). Explicit revoke from anon
    // means permission denied, not an empty result set.
    await withRollback(async (client) => {
      await actAs(client, "anon");
      expect(
        await captureRaise(client, () => client.query(`select 1 from public.${table} limit 1`)),
      ).toMatch(/permission denied/i);
    });
  });
});

describe("close-out RLS on contract_closeouts", () => {
  test("authenticated staff without contracts.close_out cannot insert", async () => {
    // Accountant is staff (is_staff) and may write_off/dispute invoices, but
    // must not open a close-out.
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const accountant = await seedUserWithRole(client, "accountant");
      await actAs(client, "authenticated", accountant);

      expect(
        await captureRaise(client, () =>
          client.query(
            `insert into public.contract_closeouts
               (contract_id, tenant_id, outcome, final_contract_state,
                move_out_date, idempotency_key)
             values ($1, $2, 'keep_terminated', 'terminated', current_date, $3)`,
            [contractId, tenantId, randomUUID()],
          ),
        ),
      ).toMatch(/row-level security|permission denied/i);
    });
  });

  test("authenticated admin with contracts.close_out can insert", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const { rows } = await client.query<{ id: string }>(
        `insert into public.contract_closeouts
           (contract_id, tenant_id, outcome, final_contract_state,
            move_out_date, idempotency_key)
         values ($1, $2, 'keep_terminated', 'terminated', current_date, $3)
         returning id`,
        [contractId, tenantId, randomUUID()],
      );
      expect(rows).toHaveLength(1);
    });
  });
});

describe("contract_operational_events is read-only for authenticated", () => {
  test("authenticated cannot insert (no write policy; no insert grant)", async () => {
    // The absence of an insert policy IS the deny for RLS, and the grant list
    // is select-only. Either layer is enough; together they stay closed when
    // someone later "fixes" one of them.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      expect(
        await captureRaise(client, () =>
          client.query(
            `insert into public.contract_operational_events (contract_id, event_type)
             values ($1, 'closeout_started')`,
            [contractId],
          ),
        ),
      ).toMatch(/permission denied|row-level security/i);
    });
  });
});

describe("close-out table constraints", () => {
  test("partial unique index rejects a second draft but allows after cancel", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const actor = await seedUserWithRole(client, "admin");

      await insertDraftCloseout(client, { contractId, tenantId });

      expect(
        await captureRaise(client, () => insertDraftCloseout(client, { contractId, tenantId })),
      ).toMatch(/duplicate key|unique/i);

      // Cancel the first draft (needs cancelled_by/at), then a new draft is ok.
      await client.query(
        `update public.contract_closeouts
            set status = 'cancelled', cancelled_by = $1, cancelled_at = now()
          where contract_id = $2 and status = 'draft'`,
        [actor, contractId],
      );

      const secondId = await insertDraftCloseout(client, { contractId, tenantId });
      expect(secondId).toBeTruthy();
    });
  });

  test("closeout_archive_tenant_needs_archive rejects archive_tenant without archive outcome", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      expect(
        await captureRaise(client, () =>
          insertDraftCloseout(client, {
            contractId,
            tenantId,
            outcome: "keep_terminated",
            finalState: "terminated",
            archiveTenant: true,
          }),
        ),
      ).toMatch(/closeout_archive_tenant_needs_archive|check constraint/i);
    });
  });

  test("closeout_completed_needs_actor rejects completed without completed_by", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      expect(
        await captureRaise(client, () =>
          insertDraftCloseout(client, {
            contractId,
            tenantId,
            status: "completed",
            completedBy: null,
            completedAt: new Date().toISOString(),
          }),
        ),
      ).toMatch(/closeout_completed_needs_actor|check constraint/i);
    });
  });

  test("a deduction with amount = 0 is rejected", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const closeoutId = await insertDraftCloseout(client, { contractId, tenantId });

      expect(
        await captureRaise(client, () =>
          client.query(
            `insert into public.contract_closeout_deductions
               (closeout_id, line, kind, amount)
             values ($1, 1, 'damages', 0)`,
            [closeoutId],
          ),
        ),
      ).toMatch(/check constraint|amount/i);
    });
  });
});
