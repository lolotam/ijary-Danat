import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural cover for migration 139, for the properties a behavioural test
 * cannot reach cheaply.
 *
 * The security half exists because of a repeated defect in this repo: Supabase
 * grants EXECUTE to `anon` and `authenticated` in their own right, so
 * `revoke … from public` alone leaves a SECURITY DEFINER function callable by
 * an unauthenticated request. Migration 96 swept the functions that existed
 * then; every function added since has to carry its own revoke, and only a test
 * that reads the migration will notice when one does not.
 */

const migration = [
  "db/migrations/139_contract_schedule_sync.sql",
  "db/migrations/141_generate_invoices_records_horizon.sql",
]
  .map((file) => readFileSync(resolve(process.cwd(), file), "utf8"))
  .join("\n");

/** The migration with SQL comments stripped — assertions judge shipped SQL. */
const code = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/** Every SECURITY DEFINER function these migrations create or replace. */
const DEFINER_FUNCTIONS = [
  { name: "bump_contract_invoice_horizon", args: "uuid, date" },
  { name: "contract_invoice_horizon", args: "uuid" },
  { name: "sync_contract_invoice_schedule", args: "uuid" },
  { name: "generate_invoices_for_year", args: "uuid, integer, boolean" },
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("migration 139 keeps anon out of every definer it ships", () => {
  test.each([...DEFINER_FUNCTIONS])(
    "revoke execute on public.$name($args) from public, anon",
    ({ name, args }) => {
      // Trailing grantees are allowed — bump_contract_invoice_horizon also
      // revokes from `authenticated`, because it writes to contracts and its
      // only callers are the definers below.
      const pattern = new RegExp(
        `revoke\\s+execute\\s+on\\s+function\\s+public\\.${escapeRegExp(name)}\\s*\\(\\s*${escapeRegExp(
          args,
        )}\\s*\\)\\s*\\n?\\s*from\\s+(?:public\\s*,\\s*anon|anon\\s*,\\s*public)\\b[^;]*;`,
        "i",
      );
      expect(pattern.test(code), `missing revoke for ${name}(${args})`).toBe(true);
    },
  );

  test("every revoke in the file names anon, not only public", () => {
    const revokes = code.match(/revoke\s+execute\s+on\s+function[^;]+;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const line of revokes) {
      expect(line, line).toMatch(/\banon\b/i);
    }
  });
});

describe("migration 139 states the rules the sync depends on", () => {
  test("the horizon column is added, not assumed", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.contracts\s+add\s+column\s+if\s+not\s+exists\s+invoices_generated_through\s+date/i,
    );
  });

  test("the horizon only ever ratchets forward", () => {
    // A bump that could lower the value would defeat the whole point: the
    // months a free-month change deletes are exactly the evidence a max() over
    // invoices would lose.
    expect(code).toMatch(
      /invoices_generated_through\s+is\s+null\s*\n?\s*or\s+c\.invoices_generated_through\s*<\s*v_max/i,
    );
  });

  test("free months are driven by the recorded count, with a legacy range fallback", () => {
    expect(code).toMatch(/coalesce\(cn\.free_months,\s*0\)\s*>\s*0/i);
    expect(code).toMatch(/make_interval\(months\s*=>\s*cn\.free_months\)/i);
  });

  test("the delete path checks every restricting reference to an invoice", () => {
    // payment_allocations and payment_requests were already covered; the
    // closeout FK is ON DELETE RESTRICT and would abort the whole sync.
    expect(code).toMatch(/payment_allocations/i);
    expect(code).toMatch(/invoice_has_pending_request/i);
    expect(code).toMatch(/contract_closeout_invoice_actions/i);
  });

  test("the contract row is locked for the duration of the reconciliation", () => {
    expect(code).toMatch(/where\s+c\.id\s*=\s*p_contract_id\s*\n?\s*for\s+update/i);
  });
});
