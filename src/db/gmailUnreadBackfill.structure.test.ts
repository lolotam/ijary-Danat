import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 102 clears only phantom unread Gmail rows —
 * when Docker is unavailable for `bun run test:sql`. Does not re-implement the
 * backfill; it asserts the shipped SQL sets is_read = true under a narrow WHERE
 * and never widens into "mark everything read" or "undo user marks".
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/102_gmail_messages_is_read_backfill.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. Run against the raw text, they made the header unable to state "this
 * never sets is_read = false" without failing its own test — so the test was
 * shaping the documentation instead of checking the code. Strip first, then
 * assert. (Same pattern as billingSafety.structure.test.ts.)
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 102 gmail_messages is_read backfill structure", () => {
  test("updates gmail_messages setting is_read = true", () => {
    expect(migrationCode).toMatch(/update\s+public\.gmail_messages\s+set\s+is_read\s*=\s*true/i);
  });

  test("WHERE requires is_read = false AND a negated UNREAD check", () => {
    // Both halves of the predicate: without is_read = false a re-run would
    // thrash deliberate local marks; without the UNREAD negation it would
    // mark genuine unread as read.
    expect(migrationCode).toMatch(/where\s+is_read\s*=\s*false/i);
    expect(migrationCode).toMatch(/not\s*\(\s*raw_payload\s*->\s*'labelIds'\s*\?\s*'UNREAD'\s*\)/i);
  });

  test("does not set is_read = false anywhere", () => {
    // WHERE may filter on is_read = false; only the SET list is forbidden from
    // assigning false — that would undo staff mark-read (local-only; no
    // gmail.modify writeback). Slice SET…WHERE so the WHERE predicate cannot
    // trip this assertion.
    const setClause = migrationCode.match(/set\s+([\s\S]*?)\s+where\b/i)?.[1] ?? "";
    expect(setClause.length, "expected an UPDATE … SET … WHERE").toBeGreaterThan(0);
    expect(setClause).not.toMatch(/is_read\s*=\s*false/i);
  });

  test("creates no table, column, index, or function", () => {
    expect(migrationCode).not.toMatch(/create\s+table/i);
    expect(migrationCode).not.toMatch(/add\s+column/i);
    expect(migrationCode).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(migrationCode).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });
});
