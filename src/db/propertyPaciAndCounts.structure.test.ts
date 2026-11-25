import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 104 adds paci_no / floor_count / unit_count
 * to public.properties — when Docker is unavailable for `bun run test:sql`.
 * Does not re-implement the schema; it asserts the shipped SQL contains the
 * three columns and non-negative checks, and omits the footguns the brief
 * forbids (not null, unique, index, drop).
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/104_property_paci_and_counts.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. The header mentions not null, unique, create index, and drop while
 * explaining why they are absent — an unstripped test would fail on its own
 * documentation. Strip first, then assert. (Same pattern as
 * billingSafety.structure.test.ts / unitFloors.structure.test.ts.)
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 104 property paci and counts structure", () => {
  test("adds paci_no, floor_count, and unit_count to public.properties with if not exists", () => {
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.properties\s+add\s+column\s+if\s+not\s+exists\s+paci_no\s+text/i,
    );
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.properties\s+add\s+column\s+if\s+not\s+exists\s+floor_count\s+integer/i,
    );
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.properties\s+add\s+column\s+if\s+not\s+exists\s+unit_count\s+integer/i,
    );
  });

  test("adds a >= 0 check for both floor_count and unit_count", () => {
    expect(migrationCode).toMatch(/check\s*\(\s*floor_count\s*>=\s*0\s*\)/i);
    expect(migrationCode).toMatch(/check\s*\(\s*unit_count\s*>=\s*0\s*\)/i);
  });

  test("does not contain not null, unique, create index, or drop", () => {
    expect(migrationCode).not.toMatch(/\bnot\s+null\b/i);
    expect(migrationCode).not.toMatch(/\bunique\b/i);
    expect(migrationCode).not.toMatch(/create\s+index\b/i);
    expect(migrationCode).not.toMatch(/\bdrop\b/i);
  });
});
