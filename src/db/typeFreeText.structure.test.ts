import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 103 converts units.type and properties.type
 * to free text, normalises the two orphaned catalogue values, and re-issues
 * the two functions that cast into the old enums — when Docker is unavailable
 * for `bun run test:sql`.
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/103_unit_property_types_free_text.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. Run against the raw text, they made the header unable to state "do not
 * drop type" without failing its own test — so the test was shaping the
 * documentation instead of checking the code. Strip first, then assert.
 * (Same pattern as billingSafety.structure.test.ts.)
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 103 unit/property types free text structure", () => {
  test("alters both columns to text with a using cast", () => {
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.units\s+alter\s+column\s+type\s+type\s+text\s+using\s+type::text/i,
    );
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.properties\s+alter\s+column\s+type\s+type\s+text\s+using\s+type::text/i,
    );
  });

  test("does not drop the unit_types or property_types enum types", () => {
    expect(migrationCode).not.toMatch(/drop\s+type/i);
  });

  test("normalises Commercial Unit → commercial_unit guarded against units", () => {
    expect(migrationCode).toMatch(/commercial_unit/);
    expect(migrationCode).toMatch(/Commercial Unit/);
    expect(migrationCode).toMatch(
      /set\s+value\s*=\s*'commercial_unit'[\s\S]*?not\s+exists\s*\(\s*select\s+1\s+from\s+public\.units/i,
    );
  });

  test("normalises Mall → mall guarded against properties", () => {
    expect(migrationCode).toMatch(/'mall'/);
    expect(migrationCode).toMatch(/'Mall'/);
    expect(migrationCode).toMatch(
      /set\s+value\s*=\s*'mall'[\s\S]*?not\s+exists\s*\(\s*select\s+1\s+from\s+public\.properties/i,
    );
  });

  test("any revoke names both public and anon", () => {
    const revokes = migrationCode.match(/revoke\s+all\s+on\s+function[\s\S]*?;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const revoke of revokes) {
      expect(revoke).toMatch(/\bpublic\b/i);
      expect(revoke).toMatch(/\banon\b/i);
    }
  });

  test("re-issues get_units_summary and bulk_import_phase6", () => {
    expect(migrationCode).toMatch(
      /create\s+or\s+replace\s+function\s+public\.get_units_summary\s*\(/i,
    );
    expect(migrationCode).toMatch(
      /create\s+or\s+replace\s+function\s+public\.bulk_import_phase6\s*\(/i,
    );
  });

  test("bulk_import_phase6 no longer casts type to unit_types or property_types", () => {
    // After strip, the free-text property/unit inserts must not cast type.
    expect(migrationCode).not.toMatch(/::\s*public\.unit_types/i);
    expect(migrationCode).not.toMatch(/::\s*public\.property_types/i);
  });
});
