import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 240 — المستأجر (Tenant) → المستثمر (Investor) in live templates.
 *
 * The migration updates the admin-editable rows in place and never re-seeds,
 * so the tests assert on the shipped rows themselves plus a replay of the
 * migration file against a row deliberately reverted to the old wording.
 */
const MIGRATION_SQL = readFileSync(
  resolve(process.cwd(), "db/migrations/240_investor_wording_templates.sql"),
  "utf8",
);

const TEMPLATE_CODES = ["invoice-document", "invoice-disputed", "invoice-written-off"] as const;

interface TemplateRow {
  code: string;
  subject_ar: string | null;
  body_ar: string | null;
  subject_en: string | null;
  body_en: string | null;
}

/** يجمع أسماء المتغيرات من النصوص الأربعة للقالب. */
function placeholderSet(row: TemplateRow): Set<string> {
  const found = new Set<string>();
  for (const field of [row.subject_ar, row.body_ar, row.subject_en, row.body_en]) {
    for (const match of (field ?? "").matchAll(/\{\{[^}]+\}\}/g)) {
      found.add(match[0]);
    }
  }
  return found;
}

/** يقرأ صفوف القوالب الثلاثة المستهدفة بالهجرة. */
async function readTargetRows(client: PoolClient): Promise<TemplateRow[]> {
  const { rows } = await client.query<TemplateRow>(
    `select code, subject_ar, body_ar, subject_en, body_en
       from public.notification_templates
      where code = any($1::text[])`,
    [TEMPLATE_CODES],
  );
  return rows;
}

describe("migration 240 - investor wording in live templates", () => {
  test("the three rows carry المستثمر, not المستأجر or Tenant labels", async () => {
    await withRollback(async (client) => {
      const rows = await readTargetRows(client);
      expect(rows.map((row) => row.code).sort()).toEqual([...TEMPLATE_CODES].sort());
      for (const row of rows) {
        const arabic = `${row.subject_ar ?? ""}${row.body_ar ?? ""}`;
        expect(arabic).not.toContain("المستأجر");
        expect(arabic).toContain("المستثمر");
        const english = `${row.subject_en ?? ""}${row.body_en ?? ""}`;
        expect(english).not.toMatch(/Tenant:|>Tenant</);
      }
    });
  });

  test("replaying the migration file changes 0 rows", async () => {
    // Idempotence is the whole contract: a second run must match nothing, so
    // an admin edit made after the migration can never be rewritten by it.
    await withRollback(async (client) => {
      const result = await client.query(MIGRATION_SQL);
      expect(result.rowCount).toBe(0);
    });
  });

  test("the update rewrites labels but keeps placeholders and prose", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates
            set subject_ar = 'نزاع المستأجر {{invoice_code}}',
                body_ar = 'المستأجر: {{tenant_name}}',
                subject_en = 'Tenant: dispute {{invoice_code}}',
                body_en = '<strong>Tenant:</strong> {{tenant_name}}<p>The tenant paid on time.</p>'
          where code = 'invoice-disputed'`,
      );
      const before = (await readTargetRows(client)).find((row) => row.code === "invoice-disputed")!;
      const beforePlaceholders = placeholderSet(before);

      const first = await client.query(MIGRATION_SQL);
      expect(first.rowCount).toBe(1);

      const after = (await readTargetRows(client)).find((row) => row.code === "invoice-disputed")!;
      const arabic = `${after.subject_ar ?? ""}${after.body_ar ?? ""}`;
      expect(arabic).not.toContain("المستأجر");
      expect(arabic).toContain("المستثمر");
      expect(arabic).toContain("{{tenant_name}}");
      const english = `${after.subject_en ?? ""}${after.body_en ?? ""}`;
      expect(english).not.toMatch(/Tenant:|>Tenant</);
      expect(english).toContain("Investor:");
      // `replace()` targets label forms only: the variable name and the plain
      // prose word "tenant" in a sentence survive the rewrite.
      expect(english).toContain("{{tenant_name}}");
      expect(english).toContain("The tenant paid on time.");
      expect(placeholderSet(after)).toEqual(beforePlaceholders);

      const second = await client.query(MIGRATION_SQL);
      expect(second.rowCount).toBe(0);
    });
  });
});
