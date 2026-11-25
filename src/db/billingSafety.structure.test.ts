import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { liveMigrationSql, resolveLiveMigrationFile } from "@/db/resolveLiveMigration";

/**
 * Structural proof that every money path that can bill an archived contract
 * still carries the archive guards from migration 82 — when Docker is
 * unavailable for `bun run test:sql`. Does not re-implement the RPCs; it
 * asserts the shipped SQL contains the guards and that migration 82 itself
 * omits the three footguns the brief forbids.
 *
 * WHY live resolution: migration 94 re-issued `regenerate_contract_invoices`
 * (and `reapply_contract_invoices`); migration 95 re-issued regenerate again.
 * Both correctly kept the archived-contract guard — but if either had dropped
 * it, a filename-pinned test that only read 82 would still pass. That is the
 * exact failure shape this suite exists to prevent. Assertions therefore run
 * against the highest-numbered definer of each function, not against 82.
 */

/**
 * Everything for one function from its LIVE migration: body plus revoke/grant
 * that follow it, ending where the next function begins.
 *
 * Deliberately NOT a fixed character window. Slicing `start + 2500` silently
 * excluded the grant for the two longest functions, so those tests failed while
 * the migration was correct — and, worse, a shorter function could have had its
 * grant deleted and still passed by borrowing the next function's.
 */
function sectionFor(name: string): string {
  const migration = liveMigrationSql(name);
  const start = migration.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is not defined in its live migration`).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf("create or replace function public.", start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

const rejectFns = [
  "generate_invoices_for_year",
  "backfill_contract_invoices",
  "reapply_contract_invoices",
  "regenerate_contract_invoices",
] as const;

const skipFns = ["evaluate_overdue", "identify_contract_expiry_reminders"] as const;

describe("billing safety for archived contracts (live migration resolution)", () => {
  test("regenerate_contract_invoices live definition is the highest re-issue, not 82", () => {
    // Proves the resolver itself cannot rot. Migration 94 re-issued this
    // function (kept the archive guard); 95 re-issued it again; 116
    // (multi-unit contracts) re-issued it once more; 119 re-issued it again to
    // refresh invoices.unit_id on regeneration (final review I2); 127 re-issued
    // it so linked discounts survive regenerate; 165 re-issued it so a
    // regenerated invoice carries the contract's recurring extra charges; 168
    // re-issued it so a free month is repriced to those charges rather than
    // cancelled; 170 reverted that and restored 165's body verbatim; 198
    // re-issued it so the line loop prices through the period pricer (rent
    // increase) — all still carrying the guard, which the archived_at
    // assertions below check against whichever file this resolves to. Each bump
    // of this expectation is a deliberate update, not rot.
    expect(resolveLiveMigrationFile("regenerate_contract_invoices")).toBe(
      "198_regenerate_uses_period_pricer.sql",
    );
    expect(resolveLiveMigrationFile("regenerate_contract_invoices")).not.toBe(
      "82_billing_safety_archived_contracts.sql",
    );
  });

  test.each([...rejectFns])("%s rejects archived contracts via archived_at is not null", (name) => {
    expect(sectionFor(name)).toMatch(/archived_at is not null/);
  });

  test("generate_invoices_for_year bulk path skips archived rows", () => {
    // The loop predicate must SKIP on bulk runs; raising would abort a
    // whole-portfolio generate because of one bad row.
    expect(sectionFor("generate_invoices_for_year")).toMatch(/c\.archived_at is null/);
  });

  test.each([...skipFns])("%s filters with c.archived_at is null", (name) => {
    expect(sectionFor(name)).toMatch(/c\.archived_at is null/);
  });
});

/**
 * Negative assertions about migration 82's own contents — not about the live
 * function bodies. Keep reading 82 by name: a later re-issue of regenerate may
 * legitimately contain different surrounding SQL, but 82 itself must still be
 * free of these three footguns. Do not "fix" these to live resolution.
 */
describe("migration 82 file contents (filename-pinned negatives)", () => {
  const migration82 = readFileSync(
    resolve(process.cwd(), "db/migrations/82_billing_safety_archived_contracts.sql"),
    "utf8",
  );

  /**
   * The migration with SQL comments stripped.
   *
   * The negative assertions below must judge the shipped SQL, not the prose that
   * documents it. Run against the raw text, they made the header unable to state
   * "this migration drops no function" without failing its own test — so the test
   * was shaping the documentation instead of checking the code. Strip first, then
   * assert, and the header is free to say exactly what it means.
   */
  const migration82Code = migration82.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

  test("does not hardcode a production contract code", () => {
    expect(migration82Code).not.toMatch(/CON-\d+/);
  });

  test("does not write units.status directly", () => {
    // Unit release is trg_contract_sync_unit_status's job (migration 76).
    expect(migration82Code).not.toMatch(/update\s+public\.units/i);
  });

  test("does not drop any function", () => {
    // No signature / OUT row-type change — a drop would reset grants.
    expect(migration82Code).not.toMatch(/drop\s+function/i);
  });
});
