import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const CODES = [
  "contact-inquiry",
  "contract-closeout",
  "contract-created",
  "contract-ended",
  "contract-expiry",
  "contract-restored",
  "deposit-confirmation",
  "due-reminder",
  "invoice-disputed",
  "invoice-document",
  "invoice-written-off",
  "maintenance-request",
  "overdue-reminder",
  "payment-admin-alert",
  "receipt",
  "refund-recorded",
  "user-credentials",
];

describe("migration 70", () => {
  test("all seventeen templates are present, active and have both bodies", async () => {
    // Scoped to migration 70's own codes. An unscoped `select code from
    // notification_templates` made this assert the whole table, so migration 72
    // adding ten workflow templates broke a test about migration 70 — a failure
    // with nothing to tell the reader about the thing it names.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where code = any($1::text[])
            and is_active and body_ar is not null and body_en is not null
          order by code`,
        [CODES],
      );
      expect(rows.map((r) => r.code)).toEqual(CODES);
    });
  });

  test("every seeded body carries at least one placeholder", async () => {
    // A body with no {{placeholder}} would render the same text for every
    // tenant — the giveaway that a value was hardcoded during the port.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where body_ar not like '%{{%' or body_en not like '%{{%'`,
      );
      expect(rows.map((r) => r.code)).toEqual([]);
    });
  });

  test("re-running the seed does not deactivate a template", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates set is_active = false where code = 'receipt'`,
      );
      await client.query(
        `update public.notification_templates
            set body_ar = '<p>{{tenant_name}}</p>' where code = 'receipt'`,
      );
      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.notification_templates where code = 'receipt'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});
