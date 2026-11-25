import { afterAll, describe, expect, test } from "vitest";

import { actAs, actAsSuperuser, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

const STRANGER = "00000000-0000-0000-0000-0000000000ff";

/**
 * Proves the actAs() helper actually switches identity and that RLS bites.
 *
 * Without this, every later RLS test would be worthless: the pool connects as
 * `postgres`, which owns every table, and FORCE ROW LEVEL SECURITY is off — so
 * an unswitched connection sees everything and a broken helper would look like
 * a passing policy. Batch B2's admin-only gmail_connections is the first thing
 * that depends on this being real.
 */
describe("actAs", () => {
  test("the pool's own role bypasses RLS", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const { rows } = await client.query(`select 1 from public.tenants where id = $1`, [
        fx.tenantId,
      ]);
      expect(rows).toHaveLength(1);
    });
  });

  test("the switched identity is actually visible to auth.uid()", async () => {
    // Without this, the whole file passes vacuously. If auth.uid() returns NULL
    // every user looks anonymous, so "this user cannot see X" succeeds for the
    // wrong reason and a policy that should have GRANTED access looks like it
    // correctly denied it. That is exactly what happened while actAs set only
    // the JSON claims GUC: this image's auth.uid() reads the flattened one.
    await withRollback(async (client) => {
      await actAs(client, "authenticated", STRANGER);
      const { rows } = await client.query<{ uid: string | null; role: string | null }>(
        "select auth.uid() as uid, auth.role() as role",
      );
      expect(rows[0].uid).toBe(STRANGER);
      expect(rows[0].role).toBe("authenticated");
    });
  });

  test("an authenticated stranger sees no tenants", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await actAs(client, "authenticated", STRANGER);

      expect(await client.query("select current_user")).toMatchObject({
        rows: [{ current_user: "authenticated" }],
      });

      const { rows } = await client.query(`select 1 from public.tenants where id = $1`, [
        fx.tenantId,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  test("anon sees no invoices", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");
      const { rows } = await client.query(`select 1 from public.invoices limit 1`);
      expect(rows).toHaveLength(0);
    });
  });

  test("actAsSuperuser restores visibility", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await actAs(client, "authenticated", STRANGER);
      await actAsSuperuser(client);

      const { rows } = await client.query(`select 1 from public.tenants where id = $1`, [
        fx.tenantId,
      ]);
      expect(rows).toHaveLength(1);
    });
  });

  test("the role switch does not survive the transaction", async () => {
    // actAs uses transaction-local set_config, so a connection returned to the
    // pool must come back as itself. If this ever fails, tests become
    // order-dependent in a way that is miserable to debug.
    await withRollback(async (client) => {
      await actAs(client, "authenticated", STRANGER);
    });
    await withRollback(async (client) => {
      const { rows } = await client.query<{ current_user: string }>("select current_user");
      expect(rows[0].current_user).toBe("postgres");
    });
  });
});
