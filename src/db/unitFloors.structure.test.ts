import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 101 adds free-text floor and the unit_floors
 * catalogue — when Docker is unavailable for `bun run test:sql`. Does not
 * re-implement the schema; it asserts the shipped SQL contains the column,
 * list registration, and seed call, and omits the two footguns that would
 * contradict the free-text decision.
 */
const migration = readFileSync(resolve(process.cwd(), "db/migrations/101_unit_floors.sql"), "utf8");

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. Run against the raw text, they made the header unable to state "this is
 * not a foreign key" without failing its own test — so the test was shaping
 * the documentation instead of checking the code. Strip first, then assert.
 * (Same pattern as billingSafety.structure.test.ts / commercialActivities.)
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const SEEDED_VALUES = ["ground", "first", "basement", "roof"] as const;

describe("migration 101 unit floors structure", () => {
  test("adds floor to public.units as text", () => {
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.units\s+add\s+column\s+if\s+not\s+exists\s+floor\s+text/i,
    );
  });

  test("inserts option_lists row with code unit_floors and on conflict do nothing", () => {
    expect(migrationCode).toMatch(/['"]unit_floors['"]/);
    expect(migrationCode).toMatch(
      /insert\s+into\s+public\.option_lists[\s\S]*unit_floors[\s\S]*on\s+conflict\s*\(\s*code\s*\)\s*do\s+nothing/i,
    );
  });

  test("calls _seed_option_items with all four starter values", () => {
    expect(migrationCode).toMatch(/_seed_option_items\s*\(\s*['"]unit_floors['"]/i);
    for (const value of SEEDED_VALUES) {
      expect(migrationCode).toMatch(new RegExp(`"value"\\s*:\\s*"${value}"`));
    }
  });

  test("does not create an enum type for floor", () => {
    expect(migrationCode).not.toMatch(/create\s+type\b/i);
    expect(migrationCode).not.toMatch(/\benum\b/i);
  });

  test("does not add a foreign key for floor", () => {
    expect(migrationCode).not.toMatch(/foreign\s+key/i);
    expect(migrationCode).not.toMatch(/references\s+public\.option_list/i);
    expect(migrationCode).not.toMatch(/references\s+option_list/i);
  });
});
