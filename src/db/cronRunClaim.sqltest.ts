import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/** يطلب حجز تشغيل مهمة ويعيد هل فاز هذا الطلب به. */
async function claim(client: PoolClient, key: string, windowSeconds = 60): Promise<boolean> {
  const { rows } = await client.query<{ won: boolean }>(
    `select public.claim_cron_run($1, $2) as won`,
    [key, windowSeconds],
  );
  return rows[0].won;
}

/**
 * Migration 229 — the database claim behind the cron route. The in-process
 * lock could not see a duplicate that arrives after the first run returned
 * (production, 2026-09-23/24: contract-expiry and notification-drain ran
 * twice ~0.5 s apart). `overdue` is a registry row every migrated database has.
 */
describe("claim_cron_run (migration 229)", () => {
  test("the first claim wins and a second inside the window loses", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.cron_jobs set last_claimed_at = null where key = 'overdue'`,
      );

      expect(await claim(client, "overdue")).toBe(true);
      expect(await claim(client, "overdue")).toBe(false);
    });
  });

  test("a claim older than the window is taken again — the next real tick runs", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.cron_jobs set last_claimed_at = now() - interval '61 seconds'
          where key = 'overdue'`,
      );

      expect(await claim(client, "overdue")).toBe(true);
    });
  });

  test("a job with no registry row is never refused", async () => {
    await withRollback(async (client) => {
      expect(await claim(client, "not-a-registered-job")).toBe(true);
      expect(await claim(client, "not-a-registered-job")).toBe(true);
    });
  });

  test("only service_role may call it", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ role: string; allowed: boolean }>(
        `select r as role, has_function_privilege(r, 'public.claim_cron_run(text, integer)', 'execute') as allowed
           from unnest(array['anon', 'authenticated', 'service_role']) as r`,
      );
      expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
    });
  });
});
