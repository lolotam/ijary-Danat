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
 * Proves migration 96: no public SECURITY DEFINER (except the three RLS
 * helpers) is anon-executable — whether the grant arrived via Route A
 * (explicit anon) or Route B (PUBLIC). Runtime SQLSTATE checks remain for
 * behaviour the privilege catalogue cannot prove.
 */

const RLS_HELPERS = ["has_permission", "is_staff", "has_role"] as const;

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

/**
 * Like captureRaise, but returns the Postgres SQLSTATE (e.g. 42501) instead of
 * the message text. Asserting on SQLSTATE is stable across locale / wording.
 */
async function captureSqlState(
  client: PoolClient,
  run: () => Promise<unknown>,
): Promise<string | null> {
  await client.query("savepoint __expect_sqlstate");
  try {
    await run();
    await client.query("release savepoint __expect_sqlstate");
    return null;
  } catch (error) {
    await client.query("rollback to savepoint __expect_sqlstate");
    await client.query("release savepoint __expect_sqlstate");
    if (error && typeof error === "object" && "code" in error) {
      return String((error as { code: unknown }).code);
    }
    return null;
  }
}

describe("anon EXECUTE catalogue (migration 96)", () => {
  test("no SECURITY DEFINER in public is anon-executable except the three RLS helpers", async () => {
    // Set-based: sampling three Route-A functions passed a half-finished
    // migration that left nine Route-B survivors. This cannot miss a name.
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prosecdef
            and has_function_privilege('anon', p.oid, 'EXECUTE')
            and p.proname not in ('has_permission', 'is_staff', 'has_role')
          order by p.proname`,
      );
      const offendingNames = rows.map((r) => r.proname);
      expect(offendingNames).toEqual([]);
    });
  });

  test("exactly has_permission, is_staff, has_role remain anon-executable definers", async () => {
    // Positive companion: an over-broad revoke fails here, not in production.
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prosecdef
            and has_function_privilege('anon', p.oid, 'EXECUTE')
          order by p.proname`,
      );
      expect(rows.map((r) => r.proname)).toEqual([...RLS_HELPERS].sort());
    });
  });
});

describe("anon EXECUTE revoked on money paths (migration 96)", () => {
  test("anon cannot call regenerate_contract_invoices (SQLSTATE 42501)", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");
      // Must fail at the privilege gate — not "Contract not found" past the
      // internal auth.role() = 'authenticated' guard.
      expect(
        await captureSqlState(client, () =>
          client.query(`select * from public.regenerate_contract_invoices($1)`, [randomUUID()]),
        ),
      ).toBe("42501");
    });
  });

  test("anon cannot call evaluate_portal_payable_invoices (SQLSTATE 42501)", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");
      expect(
        await captureSqlState(client, () =>
          client.query(`select * from public.evaluate_portal_payable_invoices($1)`, [randomUUID()]),
        ),
      ).toBe("42501");
    });
  });

  test("anon cannot call apply_payment_allocation (SQLSTATE 42501)", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");
      expect(
        await captureSqlState(client, () =>
          client.query(`select * from public.apply_payment_allocation($1, $2::jsonb)`, [
            randomUUID(),
            "[]",
          ]),
        ),
      ).toBe("42501");
    });
  });

  test("authenticated admin with invoices.create can still regenerate", async () => {
    // Regression that matters most: a revoke that also breaks the app is worse
    // than the hole.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        monthlyAmount: 400,
      });
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const { rows } = await client.query<{ action: string }>(
        `select * from public.regenerate_contract_invoices($1)`,
        [contractId],
      );
      // Assert real work, not just a resolved promise. The term is Jan–Jun 2026,
      // entirely in the past, so Pass 2 must insert six periods.
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.action === "inserted")).toBe(true);
    });
  });

  test("has_permission is still executable as anon and returns false", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");
      const { rows } = await client.query<{ ok: boolean }>(
        `select public.has_permission($1::uuid, 'invoices.create') as ok`,
        [randomUUID()],
      );
      expect(rows[0].ok).toBe(false);
    });
  });

  test("anon select on a public-role policy table returns zero rows, not a raise", async () => {
    // invoices (and tenants) policies include role `public` and call helpers
    // such as has_permission / is_staff. After migration 96 those helpers must
    // still be executable so the result is empty, not "permission denied for
    // function".
    await withRollback(async (client) => {
      await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await actAs(client, "anon");

      const raised = await captureRaise(client, () =>
        client.query(`select 1 from public.invoices limit 1`),
      );
      expect(raised).toBeNull();

      const { rows } = await client.query(`select 1 from public.invoices limit 1`);
      expect(rows).toHaveLength(0);
    });
  });
});
