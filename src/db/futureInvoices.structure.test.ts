import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Migration 94 must keep admin-generated future invoices and list them on the
 * portal — structural proof when Docker is not available for `test:sql`.
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/94_preserve_future_invoices.sql"),
  "utf8",
);
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

function sectionFor(name: string): string {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is not defined in the migration`).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf("create or replace function public.", start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

describe("migration 94 preserve future invoices", () => {
  test("regenerate no longer requires period <= current-month horizon for keep", () => {
    const section = sectionFor("regenerate_contract_invoices");
    // The old footgun: v_horizon + should_exist requiring period <= horizon.
    expect(section).not.toMatch(/v_horizon\s+date/);
    expect(section).toMatch(/period_in_free_months/);
    expect(section).toMatch(/archived_at is not null/);
  });

  test("reapply regenerates forward years after the wipe", () => {
    const section = sectionFor("reapply_contract_invoices");
    expect(section).toMatch(/generate_invoices_for_year/);
    expect(section).toMatch(/extract\(year from current_date\)/);
    expect(section).toMatch(/extract\(year from v_contract\.end_date\)/);
  });

  test("portal payable list has no LIMIT cap", () => {
    const section = sectionFor("evaluate_portal_payable_invoices");
    // Result set must not be truncated; max_visible is retained only as a
    // compatibility read of company settings.
    expect(section).not.toMatch(/\blimit\s+v_max_visible\b/i);
    expect(section).toMatch(/is_visible_to_tenant/);
  });

  test("does not drop any function", () => {
    expect(migrationCode).not.toMatch(/drop\s+function/i);
  });
});
