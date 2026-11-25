import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 99 adds free-text commercial_activity and
 * the commercial_activities catalogue — when Docker is unavailable for
 * `bun run test:sql`. Does not re-implement the schema; it asserts the shipped
 * SQL contains the column, list registration, and seed call, and omits the
 * two footguns that would contradict the free-text decision.
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/99_commercial_activities.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. Run against the raw text, they made the header unable to state "this is
 * not a foreign key" without failing its own test — so the test was shaping
 * the documentation instead of checking the code. Strip first, then assert.
 * (Same pattern as billingSafety.structure.test.ts / closeout.structure.test.ts.)
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const SEEDED_VALUES = [
  "bakery",
  "grocery",
  "fish_shop",
  "mobile_shop",
  "salon",
  "pharmacy",
  "restaurant",
] as const;

describe("migration 99 commercial activities structure", () => {
  test("adds commercial_activity to public.contracts as text", () => {
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.contracts\s+add\s+column\s+if\s+not\s+exists\s+commercial_activity\s+text/i,
    );
  });

  test("inserts option_lists row with code commercial_activities and on conflict do nothing", () => {
    expect(migrationCode).toMatch(/['"]commercial_activities['"]/);
    expect(migrationCode).toMatch(
      /insert\s+into\s+public\.option_lists[\s\S]*commercial_activities[\s\S]*on\s+conflict\s*\(\s*code\s*\)\s*do\s+nothing/i,
    );
  });

  test("calls _seed_option_items with all seven starter values", () => {
    expect(migrationCode).toMatch(/_seed_option_items\s*\(\s*['"]commercial_activities['"]/i);
    for (const value of SEEDED_VALUES) {
      expect(migrationCode).toMatch(new RegExp(`"value"\\s*:\\s*"${value}"`));
    }
  });

  test("does not create an enum type for commercial_activity", () => {
    expect(migrationCode).not.toMatch(/create\s+type\b/i);
    expect(migrationCode).not.toMatch(/\benum\b/i);
  });

  test("does not add a foreign key for commercial_activity", () => {
    expect(migrationCode).not.toMatch(/foreign\s+key/i);
    expect(migrationCode).not.toMatch(/references\s+public\.option_list/i);
    expect(migrationCode).not.toMatch(/references\s+option_list/i);
  });
});
