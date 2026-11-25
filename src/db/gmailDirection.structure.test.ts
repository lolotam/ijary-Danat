import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 100 adds gmail_messages.direction with the
 * SENT-wins backfill and list index — when Docker is unavailable for
 * `bun run test:sql`. Does not re-implement the schema; it asserts the shipped
 * SQL contains the column, CHECK, backfill, and index, and omits the footguns
 * the brief forbids (NOT NULL, enum type).
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/100_gmail_messages_direction.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. Run against the raw text, they made the header unable to state "this
 * column is deliberately nullable" without failing its own test — so the test
 * was shaping the documentation instead of checking the code. Strip first,
 * then assert. (Same pattern as billingSafety.structure.test.ts.)
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 100 gmail_messages.direction structure", () => {
  test("adds direction to public.gmail_messages with a received/sent CHECK", () => {
    expect(migrationCode).toMatch(
      /alter\s+table\s+public\.gmail_messages\s+add\s+column\s+if\s+not\s+exists\s+direction\s+text/i,
    );
    expect(migrationCode).toMatch(
      /check\s*\(\s*direction\s+in\s*\(\s*'received'\s*,\s*'sent'\s*\)\s*\)/i,
    );
  });

  test("backfills with a SENT-wins expression on labelIds", () => {
    // Either the jsonb `?` operator or an exists/jsonb_array_elements_text form.
    expect(migrationCode).toMatch(/when\s+[\s\S]*labelIds[\s\S]*SENT[\s\S]*then\s+'sent'/i);
    expect(migrationCode).toMatch(/else\s+'received'/i);
    expect(migrationCode).toMatch(/where\s+direction\s+is\s+null/i);
  });

  test("creates an index covering (company_id, direction, received_at)", () => {
    expect(migrationCode).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+gmail_messages_direction_idx\s+on\s+public\.gmail_messages\s*\(\s*company_id\s*,\s*direction\s*,\s*received_at\s+desc\s*\)/i,
    );
  });

  test("does not declare the column not null", () => {
    // Mid-deploy inserts from older code must not fail; read path treats null as received.
    expect(migrationCode).not.toMatch(/direction\s+text\s+not\s+null/i);
    expect(migrationCode).not.toMatch(/direction\s+set\s+not\s+null/i);
    expect(migrationCode).not.toMatch(/alter\s+column\s+direction\s+set\s+not\s+null/i);
  });

  test("does not create an enum type", () => {
    expect(migrationCode).not.toMatch(/create\s+type\b/i);
    expect(migrationCode).not.toMatch(/\benum\b/i);
  });
});
