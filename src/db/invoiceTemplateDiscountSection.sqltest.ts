import { readFileSync } from "node:fs";

import { afterAll, describe, expect, test } from "vitest";

import { captureRaise, closePool, withRollback } from "@/db/testDb";
import { SEEDED_BODIES_PRE_201 } from "@/lib/__fixtures__/seededBodies";

afterAll(closePool);

// The migration file carries its own `begin;` / `commit;`. Run verbatim inside
// withRollback, that `commit;` committed the test's pre-201 reseed of
// invoice-document for every later suite — found 2026-09-29 when migration
// 240's wording test saw المستأجر back in the live row. Stripping the file's
// transaction control keeps the whole run inside the test's rollback.
const MIGRATION = readFileSync(
  "db/migrations/201_invoice_template_discount_section.sql",
  "utf8",
).replace(/^\s*(begin|commit)\s*;\s*$/gim, "");

/**
 * Migration 201 — the invoice-document body hides its subtotal/discount rows
 * behind a {{#has_discount}} section, wrapped by exact-markup replacement so an
 * admin-edited body keeps every other edit.
 */
describe("migration 201", () => {
  // The suite's global setup has already applied 201, so the live row is
  // wrapped before any test runs. Install the known pre-201 body inside the
  // rollback transaction, transform it, then prove a second run is a no-op.
  test("wraps both rows once in each locale, then a second run changes nothing", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates set body_ar = $1, body_en = $2 where code = 'invoice-document'`,
        [
          SEEDED_BODIES_PRE_201["invoice-document"].ar,
          SEEDED_BODIES_PRE_201["invoice-document"].en,
        ],
      );
      await client.query(MIGRATION);
      const first = await client.query<{ body_ar: string; body_en: string }>(
        `select body_ar, body_en from public.notification_templates where code = 'invoice-document'`,
      );
      await client.query(MIGRATION);
      const second = await client.query<{ body_ar: string; body_en: string }>(
        `select body_ar, body_en from public.notification_templates where code = 'invoice-document'`,
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
      for (const col of ["body_ar", "body_en"] as const) {
        const body = first.rows[0][col];
        const original = SEEDED_BODIES_PRE_201["invoice-document"][col === "body_ar" ? "ar" : "en"];
        expect(body.split("{{#has_discount}}").length - 1).toBe(1);
        expect(body.split("{{/has_discount}}").length - 1).toBe(1);
        expect(body.indexOf("{{#has_discount}}")).toBeLessThan(body.indexOf("{{subtotal}}"));
        expect(body.indexOf("{{discount}}")).toBeLessThan(body.indexOf("{{/has_discount}}"));
        expect(body.replace("{{#has_discount}}", "").replace("{{/has_discount}}", "")).toBe(
          original,
        );
      }
    });
  });

  test("a body whose markup drifted from the literals aborts instead of passing silently", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates set body_ar = '<p>{{subtotal}} {{discount}}</p>' where code = 'invoice-document'`,
      );
      const message = await captureRaise(client, () => client.query(MIGRATION));
      expect(message).toMatch(/invoice-document body .*could not be wrapped/);
    });
  });
});
