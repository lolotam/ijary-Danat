import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * T14b — eight mutually exclusive contract-expiry buckets.
 *
 * The bug being fixed was not "too few thresholds", it was an overlap: the
 * month buckets excluded each other, but the separate `7d` arm sat entirely
 * inside the 1-month one, so a contract three days out fired twice and one of
 * its two messages read "in 1 month(s)".
 */

const AS_OF = "2026-07-01";

/** A contract ending `days` after AS_OF. */
async function seedEndingIn(client: PoolClient, days: number, state = "active") {
  const end = new Date(Date.UTC(2026, 6, 1) + days * 86_400_000).toISOString().slice(0, 10);
  return seedContract(client, {
    // Start well before, so only the end date is under test.
    startDate: "2025-01-01",
    endDate: end,
    state,
  });
}

async function bucketsFor(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{ milestone: string; days_until: number }>(
    `select milestone, days_until from public.identify_contract_expiry_reminders($1::date)
      where contract_id = $2`,
    [AS_OF, contractId],
  );
  return rows;
}

describe("bucket exclusivity", () => {
  test("a contract three days out is in 7d only, never a month-scale bucket", async () => {
    // The exact regression. Under the old definition this row came back twice.
    await withRollback(async (client) => {
      const { contractId } = await seedEndingIn(client, 3);
      const rows = await bucketsFor(client, contractId);
      expect(rows).toHaveLength(1);
      expect(rows[0].milestone).toBe("7d");
    });
  });

  test("EVERY contract yields at most one bucket, across the whole range", async () => {
    // Asserts the property rather than eight individual cases, so a ninth
    // threshold added later cannot silently reintroduce an overlap.
    await withRollback(async (client) => {
      const dayOffsets = [
        0, 1, 2, 5, 7, 8, 15, 30, 31, 45, 60, 61, 75, 90, 91, 110, 120, 121, 140, 150, 151, 170,
        180, 181, 240,
      ];
      for (const days of dayOffsets) {
        await seedEndingIn(client, days);
      }

      const { rows } = await client.query<{ contract_id: string; count: string }>(
        `select contract_id, count(*)::text as count
           from public.identify_contract_expiry_reminders($1::date)
          group by contract_id having count(*) > 1`,
        [AS_OF],
      );
      expect(rows).toEqual([]);
    });
  });

  test("each bucket fires at its midpoint", async () => {
    await withRollback(async (client) => {
      const cases: Array<[number, string]> = [
        [0, "1d"],
        [1, "1d"],
        [4, "7d"],
        [20, "30d"],
        [45, "60d"],
        [75, "90d"],
        [105, "120d"],
        [135, "150d"],
        [170, "180d"],
      ];
      for (const [days, expected] of cases) {
        const { contractId } = await seedEndingIn(client, days);
        const rows = await bucketsFor(client, contractId);
        expect(rows.map((row) => row.milestone)).toEqual([expected]);
      }
    });
  });

  test("boundaries land in the tighter bucket", async () => {
    await withRollback(async (client) => {
      // 7 days is the last day of `7d`, 8 the first of `30d`.
      const seven = await seedEndingIn(client, 7);
      const eight = await seedEndingIn(client, 8);
      expect((await bucketsFor(client, seven.contractId))[0].milestone).toBe("7d");
      expect((await bucketsFor(client, eight.contractId))[0].milestone).toBe("30d");
    });
  });
});

describe("what is excluded", () => {
  test("an already-expired contract yields nothing", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedEndingIn(client, -5);
      expect(await bucketsFor(client, contractId)).toHaveLength(0);
    });
  });

  test("a contract beyond 180 days yields nothing", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedEndingIn(client, 200);
      expect(await bucketsFor(client, contractId)).toHaveLength(0);
    });
  });

  test("only active contracts are considered", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedEndingIn(client, 5, "frozen");
      expect(await bucketsFor(client, contractId)).toHaveLength(0);
    });
  });
});

describe("the WhatsApp leg is no longer dead", () => {
  test("contract-expiry templates carry a provider template name and params", async () => {
    // Migration 38 added these columns and the WhatsApp sender refuses to send
    // without them, but no migration ever seeded them for these two templates.
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        code: string;
        provider_template_name: string | null;
        provider_param_keys: string[];
      }>(
        `select code, provider_template_name, provider_param_keys
           from public.notification_templates
          where code = 'contract-expiry'`,
      );
      expect(rows).toHaveLength(1);
      for (const row of rows) {
        expect(row.provider_template_name).toBeTruthy();
        expect(row.provider_template_name).not.toBe("META_TEMPLATE_NAME_REQUIRED");
        expect(row.provider_param_keys).toContain("days_until");
      }
    });
  });

  test("the template body no longer uses the placeholder the job never sent", async () => {
    // Bodies used {{months_until_expiry}}; the payload carried `months_until`,
    // so the token shipped to tenants literally.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ body_ar: string; body_en: string }>(
        `select body_ar, body_en from public.notification_templates
          where code = 'contract-expiry'`,
      );
      expect(rows[0].body_ar).not.toContain("months_until_expiry");
      expect(rows[0].body_en).not.toContain("months_until_expiry");
      expect(rows[0].body_en).toContain("{{days_until}}");
    });
  });
});

describe("cron registry", () => {
  test("is seeded with every job in the code registry", async () => {
    // Scoped to `kind = 'scheduled'` since migration 69: the same table now
    // also registers event-triggered workflows, which have no entry in the
    // JOBS map and are not dispatchable by the cron endpoint. This assertion is
    // about keeping the seed in step with that map, so it stays scheduled-only.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs where kind = 'scheduled' order by key`,
      );
      expect(rows.map((row) => row.key).sort()).toEqual(
        [
          "backup",
          "contract-expiry",
          "gmail-sync",
          "log-retention",
          "notification-drain",
          "overdue",
          "overdue-reminders",
          "payment-reconcile",
          "salaries",
          "scheduled-reports",
        ].sort(),
      );
    });
  });

  test("every job starts active and unrun", async () => {
    // On production this is also the honest current state: nothing schedules
    // any of these, so last_run_at is empty for all of them.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ is_active: boolean; last_run_at: string | null }>(
        `select is_active, last_run_at from public.cron_jobs`,
      );
      expect(rows.every((row) => row.is_active)).toBe(true);
      expect(rows.every((row) => row.last_run_at === null)).toBe(true);
    });
  });

  test("record_cron_run stamps the outcome", async () => {
    await withRollback(async (client) => {
      await client.query(`select public.record_cron_run('overdue', 'success', 1234, null)`);
      const { rows } = await client.query<{
        last_status: string;
        last_duration_ms: number;
        last_run_at: string | null;
      }>(
        `select last_status, last_duration_ms, last_run_at from public.cron_jobs where key = 'overdue'`,
      );
      expect(rows[0].last_status).toBe("success");
      expect(rows[0].last_duration_ms).toBe(1234);
      expect(rows[0].last_run_at).not.toBeNull();
    });
  });

  test("last_status is constrained to the three real outcomes", async () => {
    await withRollback(async (client) => {
      await expect(
        client.query(`update public.cron_jobs set last_status = 'maybe' where key = 'overdue'`),
      ).rejects.toThrow(/check constraint/i);
    });
  });
});
