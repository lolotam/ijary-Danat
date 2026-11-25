import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 98 adds a permission-gated DELETE policy on
 * public.generated_reports (and only policy/grant work — no schema rewrite).
 *
 * Fast: no Docker. Complements generatedReportsRls.sqltest.ts.
 */

const migration98 = readFileSync(
  resolve(process.cwd(), "db/migrations/98_generated_reports_delete_policy.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. Same approach as billingSafety.structure.test.ts for migration 82.
 */
const migration98Code = migration98.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/**
 * Revoke must name public, anon, and authenticated (any order).
 * Supabase default privileges granted ALL to both anon and authenticated on
 * top of migration 07's SELECT-only intent; revoking only public+anon leaves
 * authenticated with INSERT/UPDATE/TRUNCATE.
 */
const THREE_GRANTEES = String.raw`from\s+(?:public|anon|authenticated)(?:\s*,\s*(?:public|anon|authenticated)){2}\b`;

describe("migration 98 generated_reports delete policy", () => {
  test("contains a for delete policy on generated_reports gated on reports.delete", () => {
    expect(migration98Code).toMatch(
      /create\s+policy\s+generated_reports_delete_permitted[\s\S]*?on\s+public\.generated_reports\s+for\s+delete\s+to\s+authenticated[\s\S]*?has_permission\s*\(\s*auth\.uid\s*\(\s*\)\s*,\s*'reports\.delete'\s*\)/i,
    );
  });

  test("delete policy is preceded by drop policy if exists", () => {
    const dropIdx = migration98Code.search(
      /drop\s+policy\s+if\s+exists\s+generated_reports_delete_permitted\s+on\s+public\.generated_reports/i,
    );
    const createIdx = migration98Code.search(
      /create\s+policy\s+generated_reports_delete_permitted/i,
    );
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  test("any revoke names public, anon, and authenticated", () => {
    const revokes = migration98Code.match(/revoke\s+[^;]+;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const line of revokes) {
      expect(line, line).toMatch(new RegExp(THREE_GRANTEES, "i"));
      expect(line, line).toMatch(/\bpublic\b/i);
      expect(line, line).toMatch(/\banon\b/i);
      expect(line, line).toMatch(/\bauthenticated\b/i);
    }
  });

  test("grants authenticated only select and delete — not insert, update, or truncate", () => {
    const grants = migration98Code.match(/grant\s+[^;]+to\s+authenticated\s*;/gi) ?? [];
    expect(grants.length).toBeGreaterThan(0);
    for (const line of grants) {
      // Allowed surface for browser path (useGeneratedReports + delete mutation).
      expect(line, line).toMatch(/\bselect\b/i);
      expect(line, line).toMatch(/\bdelete\b/i);
      // Writes go only through service_role (runReportSchedule / resendGeneratedReport).
      expect(line, line).not.toMatch(/\binsert\b/i);
      expect(line, line).not.toMatch(/\bupdate\b/i);
      expect(line, line).not.toMatch(/\btruncate\b/i);
      expect(line, line).not.toMatch(/\ball\b/i);
    }
  });

  test("policy-and-grant only — no create or replace function", () => {
    expect(migration98Code).not.toMatch(/create\s+or\s+replace\s+function/i);
  });

  test("policy-and-grant only — no create table", () => {
    expect(migration98Code).not.toMatch(/create\s+table/i);
  });
});
