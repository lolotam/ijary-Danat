import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const KEYS = [
  "contact-inquiry-received",
  "contract-created",
  "contract-ended",
  "maintenance-request-created",
  "refund-recorded",
];

const CODES = [
  "contact-inquiry",
  "contract-created",
  "contract-ended",
  "maintenance-request",
  "refund-recorded",
];

describe("migration 71 - the enum", () => {
  test("the five new notification types exist", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ v: string }>(
        `select unnest(enum_range(null::public.notification_types))::text as v`,
      );
      const values = rows.map((row) => row.v);
      for (const type of [
        "contact_inquiry",
        "maintenance_request",
        "refund_recorded",
        "contract_created",
        "contract_ended",
      ]) {
        expect(values).toContain(type);
      }
    });
  });
});

describe("migration 72 - rows", () => {
  test("the five workflows are registered as events", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs
          where kind = 'event' and key = any($1::text[]) order by key`,
        [KEYS],
      );
      expect(rows.map((row) => row.key)).toEqual(KEYS);
    });
  });

  test("the registry holds at least the sixteen rows from migrations 58/69/72", async () => {
    // Later migrations (80, 89, …) add more event rows. Assert a floor, not an
    // exact total, so this suite stays stable when close-out workflows land.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from public.cron_jobs`,
      );
      expect(Number(rows[0].n)).toBeGreaterThanOrEqual(16);
    });
  });

  test("five templates exist, active, with both bodies", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where code = any($1::text[])
            and is_active and body_ar is not null and body_en is not null
          order by code`,
        [CODES],
      );
      expect(rows.map((row) => row.code)).toEqual(CODES);
    });
  });

  test("re-running the seed does not re-enable a paused workflow", async () => {
    await withRollback(async (client) => {
      const { rows: targetRows } = await client.query<{ company_id: string }>(
        `select company_id from public.cron_jobs where key = 'refund-recorded' limit 1`,
      );
      const companyId = targetRows[0].company_id;
      await client.query(
        `update public.cron_jobs set is_active = false
          where company_id = $1 and key = 'refund-recorded'`,
        [companyId],
      );
      await client.query(
        `insert into public.cron_jobs (company_id, key, kind, name_ar, name_en)
           values ($1, 'refund-recorded', 'event', 'ر', 'Refund recorded')
         on conflict (company_id, key) do update
           set kind = excluded.kind, name_ar = excluded.name_ar, name_en = excluded.name_en`,
        [companyId],
      );
      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs
          where company_id = $1 and key = 'refund-recorded'`,
        [companyId],
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});
