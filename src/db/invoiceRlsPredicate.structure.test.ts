import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { liveMigrationSql } from "@/db/resolveLiveMigration";

/**
 * يستخرج شرط سياسة اختيار الفواتير كما شُحن في الهجرة 05.
 *
 * The policy has never been re-issued; reading 05 is the live definition.
 * Normalising whitespace is the whole point: a wrap difference must not hide
 * a real predicate drift, and a missing `invoices.tenant_id` must still fail.
 */
function invoicesSelectAllowedPredicate(): string {
  const sql = readFileSync(
    resolve(process.cwd(), "db/migrations/05_phase3_invoices_payments.sql"),
    "utf8",
  );
  const match = sql.match(
    /create policy invoices_select_allowed on public\.invoices for select to authenticated using \(([\s\S]*?)\);/,
  );
  if (!match) throw new Error("invoices_select_allowed policy not found in migration 05");
  return match[1].replace(/\s+/g, " ").trim();
}

describe("get_invoice_payment_breakdown authorisation predicate", () => {
  test("contains the invoices_select_allowed predicate text", () => {
    const predicate = invoicesSelectAllowedPredicate();
    const breakdown = liveMigrationSql("get_invoice_payment_breakdown").replace(/\s+/g, " ");
    expect(predicate.length).toBeGreaterThan(40);
    expect(breakdown).toContain(predicate);
  });
});
