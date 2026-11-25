import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 243 — every RLS policy in `public` evaluates its auth helpers once
 * per statement, not once per row.
 *
 * A bare `public.is_staff(auth.uid())` in a policy runs for every row the
 * query touches: on production (2026-10-05) counting 4,628 invoices as an
 * admin called it 4,628 times, 47.9 ms against 2.9 ms once wrapped as
 * `(select public.is_staff((select auth.uid())))`. Nothing fails when a new
 * migration reintroduces the slow form — pages just get slower — so this test
 * is the only thing that notices.
 */
describe("RLS auth checks are hoisted (migration 243)", () => {
  test("no public policy calls auth.uid() outside a scalar sub-select", async () => {
    await withRollback(async (client) => {
      await client.query("set local search_path = pg_catalog");
      const { rows } = await client.query<{ policy: string }>(
        `select c.relname || '.' || p.polname as policy
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
                || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                ~ '(?<!SELECT )auth\\.uid\\(\\)'
          order by 1`,
      );
      expect(rows.map((row) => row.policy)).toEqual([]);
    });
  });
});
