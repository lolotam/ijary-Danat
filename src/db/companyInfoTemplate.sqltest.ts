import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const SEED = readFileSync(
  resolve(process.cwd(), "db/migrations/137_seed_company_info_template.sql"),
  "utf8",
);

describe("migration 137 - company-info template", () => {
  test("the company-info row exists, is active, and carries both languages", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        code: string;
        type: string;
        channel: string;
        is_active: boolean;
        subject_ar: string | null;
        subject_en: string | null;
        body_ar: string | null;
        body_en: string | null;
      }>(
        `select code, type::text, channel::text, is_active,
                subject_ar, subject_en, body_ar, body_en
           from public.notification_templates
          where code = 'company-info'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("company_info");
      expect(rows[0].channel).toBe("both");
      expect(rows[0].is_active).toBe(true);
      expect(rows[0].subject_ar?.trim().length).toBeGreaterThan(0);
      expect(rows[0].subject_en?.trim().length).toBeGreaterThan(0);
      expect(rows[0].body_ar).toContain("{{");
      expect(rows[0].body_en).toContain("{{");
    });
  });

  test("replaying the seed does not overwrite an admin edit or re-enable", async () => {
    // ON CONFLICT DO NOTHING is the whole point: a replay that reset
    // subject/body would wipe Settings edits, and one that set is_active
    // true would turn a disabled template back on.
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates
            set is_active = false,
                subject_ar = 'نسخة الإدارة',
                body_ar = '<p>{{tenant_name}}</p>'
          where code = 'company-info'`,
      );
      await client.query(SEED);
      const { rows } = await client.query<{
        is_active: boolean;
        subject_ar: string | null;
        body_ar: string | null;
      }>(
        `select is_active, subject_ar, body_ar
           from public.notification_templates
          where code = 'company-info'`,
      );
      expect(rows[0].is_active).toBe(false);
      expect(rows[0].subject_ar).toBe("نسخة الإدارة");
      expect(rows[0].body_ar).toBe("<p>{{tenant_name}}</p>");
    });
  });
});
