import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";
import { LEGACY_TEMPLATE_CODES, LEGACY_TEMPLATE_STEMS } from "@/lib/legacyTemplateCodes";

afterAll(closePool);

describe("migration 125 — template locale collapse", () => {
  test("no legacy code survives", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates where code = any($1::text[])`,
        [LEGACY_TEMPLATE_CODES],
      );
      expect(rows).toEqual([]);
    });
  });

  test("every stem exists exactly once", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where code = any($1::text[]) order by code`,
        [[...LEGACY_TEMPLATE_STEMS]],
      );
      expect(rows.map((r) => r.code)).toEqual([...LEGACY_TEMPLATE_STEMS].sort());
    });
  });

  test("the locale column is gone", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `select 1 from information_schema.columns
          where table_name = 'notification_templates' and column_name = 'locale'`,
      );
      expect(rows).toEqual([]);
    });
  });

  // Seed the history this migration is supposed to rewrite. Querying the clean
  // database instead would pass even if the rewrite were deleted entirely — the
  // fixtures contain no notification rows.
  test("history pointing at a legacy code is re-pointed, not orphaned", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ ok: boolean }>(
        `select exists(
           select 1 from public.notification_templates where code = 'receipt'
         ) as ok`,
      );
      expect(rows[0]?.ok).toBe(true);
      // Inserting with a legacy code must now fail the FK, proving the rows are
      // gone and that any old-bundle write would have been caught.
      await expect(
        client.query(
          `insert into public.notifications (audience, type, channel, locale, template_code, state)
             values ('tenant','receipt','email','ar','receipt-ar','queued')`,
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  // Migration 58 seeds this on a clean database; the merge must carry it over.
  test("the contract-expiry provider mapping survives the merge", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ provider_template_name: string | null }>(
        `select provider_template_name from public.notification_templates
          where code = 'contract-expiry'`,
      );
      expect(rows[0]?.provider_template_name).toBe("contract_expiry_notice");
    });
  });
});
