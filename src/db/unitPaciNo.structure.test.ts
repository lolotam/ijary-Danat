import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 105 adds paci_no to public.units — when
 * Docker is unavailable for `bun run test:sql`. Does not re-implement the
 * schema; it asserts the shipped SQL contains the column and omits the
 * footguns the brief forbids (not null, unique, index, check, drop).
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/105_unit_paci_no.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. The header mentions not null, unique, create index, check, and drop while
 * explaining why they are absent — an unstripped test would fail on its own
 * documentation. Strip first, then assert. (Same pattern as
 * propertyPaciAndCounts.structure.test.ts.)
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 105 unit paci_no structure", () => {
  test("adds paci_no to public.units with if not exists", () => {
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.units\s+add\s+column\s+if\s+not\s+exists\s+paci_no\s+text/i,
    );
  });

  test("does not contain not null, unique, create index, check (, or drop", () => {
    expect(migrationCode).not.toMatch(/\bnot\s+null\b/i);
    expect(migrationCode).not.toMatch(/\bunique\b/i);
    expect(migrationCode).not.toMatch(/create\s+index\b/i);
    expect(migrationCode).not.toMatch(/check\s*\(/i);
    expect(migrationCode).not.toMatch(/\bdrop\b/i);
  });
});
