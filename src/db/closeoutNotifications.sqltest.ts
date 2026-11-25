import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يعيد الجزء السابق لإدراج القوالب من ملف الترحيل، للتحقق من تكرار التطبيق.
 *
 * Migrations 89 and 93 insert notification_templates naming `locale`, a column
 * migration 125 drops — so the whole file can no longer be replayed. These tests
 * assert cron_jobs.is_active, which the prefix fully covers.
 *
 * Throws rather than slicing on a miss: `indexOf` returns -1 when the statement
 * is renamed, and `slice(0, -1)` would silently replay almost the entire
 * migration and fail somewhere unrelated.
 */
function cronJobsPrefix(seed: string): string {
  const marker = "insert into public.notification_templates";
  const cut = seed.indexOf(marker);
  if (cut < 0) throw new Error(`Expected "${marker}" in the migration; has it been renamed?`);
  return seed.slice(0, cut);
}

const KEYS = ["contract-closeout-completed", "contract-restored"] as const;
const CODES = ["contract-closeout", "contract-restored"] as const;

const INVOICE_EVENT_KEYS = ["invoice-written-off", "invoice-disputed"] as const;
const INVOICE_EVENT_CODES = ["invoice-disputed", "invoice-written-off"] as const;

describe("migration 88 - close-out notification enum values", () => {
  test("contract_closeout and contract_restored exist on the enum", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ v: string }>(
        `select unnest(enum_range(null::public.notification_types))::text as v`,
      );
      const values = rows.map((row) => row.v);
      expect(values).toContain("contract_closeout");
      expect(values).toContain("contract_restored");
    });
  });
});

describe("migration 89 - close-out workflows and templates", () => {
  test("both cron_jobs rows exist with kind=event and valid recipient_targets", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        key: string;
        kind: string;
        recipient_targets: string[];
      }>(
        `select key, kind, recipient_targets
           from public.cron_jobs
          where key = any($1::text[])
          order by key`,
        [KEYS as unknown as string[]],
      );
      expect(rows.map((r) => r.key).sort()).toEqual([...KEYS].sort());
      for (const row of rows) {
        expect(row.kind).toBe("event");
        expect(row.recipient_targets.length).toBeGreaterThan(0);
        for (const target of row.recipient_targets) {
          expect(["admin", "company", "tenant"]).toContain(target);
        }
      }
    });
  });

  test("both notification_templates rows exist with non-empty ar/en subject and body", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        code: string;
        subject_ar: string | null;
        subject_en: string | null;
        body_ar: string | null;
        body_en: string | null;
      }>(
        `select code, subject_ar, subject_en, body_ar, body_en
           from public.notification_templates
          where code = any($1::text[])
          order by code`,
        [CODES as unknown as string[]],
      );
      expect(rows.map((r) => r.code)).toEqual([...CODES]);
      for (const row of rows) {
        expect(row.subject_ar?.trim().length).toBeGreaterThan(0);
        expect(row.subject_en?.trim().length).toBeGreaterThan(0);
        expect(row.body_ar?.trim().length).toBeGreaterThan(0);
        expect(row.body_en?.trim().length).toBeGreaterThan(0);
      }
    });
  });

  test("neither template row carries META_TEMPLATE_NAME_REQUIRED or a provider name", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        code: string;
        provider_template_name: string | null;
      }>(
        `select code, provider_template_name
           from public.notification_templates
          where code = any($1::text[])`,
        [CODES as unknown as string[]],
      );
      for (const row of rows) {
        expect(row.provider_template_name).toBeNull();
        expect(row.provider_template_name).not.toBe("META_TEMPLATE_NAME_REQUIRED");
      }
    });
  });

  test("re-running 89 does not flip is_active", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.cron_jobs set is_active = false where key = 'contract-closeout-completed'`,
      );

      const seed = readFileSync(
        resolve(process.cwd(), "db/migrations/89_closeout_workflows_and_templates.sql"),
        "utf8",
      );
      await client.query(cronJobsPrefix(seed));

      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs where key = 'contract-closeout-completed'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});

describe("migration 92/93 - invoice write-off and dispute notifications", () => {
  test("invoice_written_off and invoice_disputed exist on the enum", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ v: string }>(
        `select unnest(enum_range(null::public.notification_types))::text as v`,
      );
      const values = rows.map((row) => row.v);
      expect(values).toContain("invoice_written_off");
      expect(values).toContain("invoice_disputed");
    });
  });

  test("both cron_jobs rows exist with kind=event and valid recipient_targets", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        key: string;
        kind: string;
        recipient_targets: string[];
      }>(
        `select key, kind, recipient_targets
           from public.cron_jobs
          where key = any($1::text[])
          order by key`,
        [INVOICE_EVENT_KEYS as unknown as string[]],
      );
      expect(rows.map((r) => r.key).sort()).toEqual([...INVOICE_EVENT_KEYS].sort());
      for (const row of rows) {
        expect(row.kind).toBe("event");
        expect(row.recipient_targets.length).toBeGreaterThan(0);
        for (const target of row.recipient_targets) {
          expect(["admin", "company", "tenant"]).toContain(target);
        }
      }
    });
  });

  test("both notification_templates rows exist with non-empty ar/en subject and body", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        code: string;
        subject_ar: string | null;
        subject_en: string | null;
        body_ar: string | null;
        body_en: string | null;
      }>(
        `select code, subject_ar, subject_en, body_ar, body_en
           from public.notification_templates
          where code = any($1::text[])
          order by code`,
        [INVOICE_EVENT_CODES as unknown as string[]],
      );
      expect(rows.map((r) => r.code)).toEqual([...INVOICE_EVENT_CODES]);
      for (const row of rows) {
        expect(row.subject_ar?.trim().length).toBeGreaterThan(0);
        expect(row.subject_en?.trim().length).toBeGreaterThan(0);
        expect(row.body_ar?.trim().length).toBeGreaterThan(0);
        expect(row.body_en?.trim().length).toBeGreaterThan(0);
      }
    });
  });

  test("neither template row carries META_TEMPLATE_NAME_REQUIRED or a provider name", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        code: string;
        provider_template_name: string | null;
      }>(
        `select code, provider_template_name
           from public.notification_templates
          where code = any($1::text[])`,
        [INVOICE_EVENT_CODES as unknown as string[]],
      );
      for (const row of rows) {
        expect(row.provider_template_name).toBeNull();
        expect(row.provider_template_name).not.toBe("META_TEMPLATE_NAME_REQUIRED");
      }
    });
  });

  test("re-running 93 does not flip is_active", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.cron_jobs set is_active = false where key = 'invoice-written-off'`,
      );

      const seed = readFileSync(
        resolve(process.cwd(), "db/migrations/93_invoice_event_workflows.sql"),
        "utf8",
      );
      await client.query(cronJobsPrefix(seed));

      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs where key = 'invoice-written-off'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});
