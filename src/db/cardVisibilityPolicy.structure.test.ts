import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 132 fixed the unsatisfiable card_visibility
 * RLS policies — migration 126 scoped both policies to
 * `company_id = (select p.company_id from public.profiles p …)`, but
 * `profiles.company_id` is NULL for every user in this deployment, so the
 * subselect yielded NULL and `company_id = NULL` was never true. No one could
 * read or write. Migration 132 drops that profiles-scoped term entirely.
 *
 * Filename-pinned to 132: 132 is the migration that re-creates the policies, so
 * its file is the thing that must be free of the `profiles` term. Do not switch
 * this to live-resolution — the policies are not CREATE OR REPLACE FUNCTION and
 * `resolveLiveMigrationFile` only resolves functions.
 */

const migration132 = readFileSync(
  resolve(process.cwd(), "db/migrations/132_card_visibility_policy_fix.sql"),
  "utf8",
);

/** Migration text with comments stripped, so assertions judge shipped SQL only. */
const migration132Code = migration132.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 132 — card_visibility policy fix (filename-pinned)", () => {
  test("SELECT policy uses using (true), not a profiles-scoped subquery", () => {
    // The select policy must grant every authenticated reader. Any reference
    // to profiles.company_id reintroduces the unsatisfiable term.
    const selectSection = slicePolicy(migration132Code, "card_visibility_select");
    expect(selectSection).toMatch(/for select to authenticated/);
    expect(selectSection).toMatch(/using\s*\(\s*true\s*\)/);
    expect(selectSection).not.toMatch(/profiles/);
  });

  test("WRITE policy keeps has_permission and drops the company_id profiles term", () => {
    const writeSection = slicePolicy(migration132Code, "card_visibility_write");
    expect(writeSection).toMatch(/for all to authenticated/);
    // The real protection — kept.
    expect(writeSection).toMatch(
      /has_permission\s*\(\s*auth\.uid\(\)\s*,\s*'company\.update'\s*\)/,
    );
    // The unsatisfiable term — gone from both using and with check.
    expect(writeSection).not.toMatch(/profiles/);
    expect(writeSection).not.toMatch(/company_id\s*=/);
  });

  test("drops both old policies before re-creating, so re-applying is idempotent", () => {
    expect(migration132Code).toMatch(/drop policy if exists card_visibility_select/i);
    expect(migration132Code).toMatch(/drop policy if exists card_visibility_write/i);
  });
});

/**
 * يستخرج نص سياسة واحدة من ملف التهجير: من `create policy <name>` حتى سياسة المقبل أو نهاية الملف.
 *
 * A fixed character window would silently include the next policy's body; this
 * stops at the next `create policy` or end of file.
 */
function slicePolicy(sql: string, policyName: string): string {
  const start = sql.indexOf(`create policy ${policyName}`);
  expect(start, `${policyName} is not defined in migration 132`).toBeGreaterThanOrEqual(0);
  const next = sql.indexOf("create policy ", start + 1);
  return sql.slice(start, next === -1 ? undefined : next);
}
