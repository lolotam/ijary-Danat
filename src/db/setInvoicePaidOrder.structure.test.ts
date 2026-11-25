import { describe, expect, test } from "vitest";

import { liveMigrationSql, resolveLiveMigrationFile } from "@/db/resolveLiveMigration";

/**
 * Structural proof that the live `set_invoice_paid` still carries the
 * per-contract, paid-only chronological guard from migration 129.
 *
 * A later migration that re-issues the function without the guard would keep
 * the SQL tests green only while Docker is running; this file runs in
 * `bun run test` and fails as soon as the live body loses the predicate.
 */
describe("set_invoice_paid chronological guard (live SQL)", () => {
  test("the live definition is migration 129 or later", () => {
    const file = resolveLiveMigrationFile("set_invoice_paid");
    const number = Number.parseInt(file, 10);
    expect(number, file).toBeGreaterThanOrEqual(129);
  });

  test("raises the chronological-order message only after locking the invoice", () => {
    const sql = liveMigrationSql("set_invoice_paid");
    const lockAt = sql.indexOf("for update");
    const raiseAt = sql.indexOf("Invoices must be paid in chronological order.");
    expect(lockAt, "select ... for update is missing").toBeGreaterThanOrEqual(0);
    expect(raiseAt, "chronological exception is missing").toBeGreaterThanOrEqual(0);
    expect(raiseAt).toBeGreaterThan(lockAt);
  });

  test("the predicate is per-contract and paid-only", () => {
    const sql = liveMigrationSql("set_invoice_paid");
    expect(sql).toMatch(/if p_paid then/);
    expect(sql).toMatch(/earlier\.contract_id = v_invoice\.contract_id/);
    expect(sql).toMatch(
      /\(earlier\.period_year,\s*earlier\.period_month\)\s*<\s*\(v_invoice\.period_year,\s*v_invoice\.period_month\)/,
    );
  });
});
