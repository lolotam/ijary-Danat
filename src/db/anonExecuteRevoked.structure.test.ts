import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 96 revokes EXECUTE from **both** PUBLIC and
 * `anon` on every group-3 SECURITY DEFINER function, without touching the three
 * RLS helpers (group 1) and without rewriting function bodies or re-granting.
 *
 * Fast: no Docker. Complements `anonExecute.sqltest.ts`.
 *
 * Matching only `from anon` would pass a migration that still leaves Route B
 * (PUBLIC `=X`) open — which is exactly the failure this suite must prevent.
 */

/** Group-3 callables that must lose PUBLIC + anon EXECUTE. */
export const GROUP_3_REVOKE_TARGETS = [
  { name: "apply_payment_allocation", args: "uuid, jsonb" },
  { name: "backfill_contract_invoices", args: "uuid" },
  { name: "contract_period_amounts", args: "uuid, date" },
  { name: "evaluate_overdue", args: "date" },
  { name: "evaluate_portal_payable_invoices", args: "uuid, integer" },
  { name: "generate_electricity_charges", args: "integer, integer, uuid" },
  { name: "generate_invoices", args: "uuid, integer" },
  { name: "generate_invoices_for_year", args: "uuid, integer, boolean" },
  { name: "generate_salaries_for_month", args: "integer, integer" },
  { name: "invoice_has_pending_request", args: "uuid" },
  { name: "reapply_contract_invoices", args: "uuid" },
  { name: "receipt_html_for_payment", args: "uuid" },
  { name: "regenerate_contract_invoices", args: "uuid" },
  { name: "reverse_payment", args: "uuid, text" },
  { name: "set_invoice_paid", args: "uuid, boolean" },
  { name: "_seed_option_items", args: "text, jsonb" },
  { name: "build_scheduled_report_html", args: "uuid, date" },
  { name: "erase_all_data", args: "" },
  { name: "get_budget_summary", args: "date, date, uuid, uuid" },
  { name: "get_deposit_total", args: "date, date, text, text, text" },
  { name: "identify_contract_expiry_reminders", args: "date" },
  { name: "record_cron_run", args: "text, text, integer, text" },
  { name: "write_audit", args: "text, text, uuid, jsonb, jsonb, text, text" },
  { name: "next_building_code", args: "" },
  { name: "next_contract_code", args: "" },
  { name: "next_electricity_charge_code", args: "" },
  { name: "next_employee_code", args: "" },
  { name: "next_invoice_code", args: "" },
  { name: "next_maintenance_request_code", args: "" },
  { name: "next_payment_code", args: "" },
  { name: "next_payment_request_code", args: "" },
  { name: "next_property_code", args: "" },
  { name: "next_receipt_code", args: "" },
  { name: "next_tenant_code", args: "" },
  { name: "next_unit_code", args: "" },
  { name: "compute_electricity_amount", args: "uuid, numeric" },
  { name: "compute_tenant_lifecycle", args: "uuid, public.tenant_lifecycle" },
  { name: "compute_unit_status", args: "uuid, public.unit_status" },
  { name: "set_tenant_blocked", args: "uuid, boolean" },
  { name: "sync_tenant_lifecycle_for", args: "uuid" },
  { name: "sync_unit_status_for", args: "uuid" },
  { name: "unit_has_active_contract", args: "uuid" },
] as const;

/** RLS helpers that must keep anon EXECUTE. */
export const GROUP_1_EXEMPT = ["has_permission", "is_staff", "has_role"] as const;

const migration96 = readFileSync(
  resolve(process.cwd(), "db/migrations/96_revoke_anon_execute_on_definer_functions.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * Negative assertions must judge the shipped SQL, not the prose that documents
 * it. Same approach as billingSafety.structure.test.ts for migration 82.
 */
const migration96Code = migration96.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/** Either order, flexible whitespace: from public, anon | from anon, public */
const BOTH_GRANTEES = String.raw`from\s+(?:public\s*,\s*anon|anon\s*,\s*public)\s*`;

function hasRevokeFromPublicAndAnon(name: string, args: string): boolean {
  const argPart = args.trim() === "" ? "\\s*" : `\\s*${escapeRegExp(args)}\\s*`;
  const re = new RegExp(
    `revoke\\s+execute\\s+on\\s+function\\s+public\\.${escapeRegExp(name)}\\s*\\(${argPart}\\)\\s+${BOTH_GRANTEES};`,
    "i",
  );
  return re.test(migration96Code);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("migration 96 revokes EXECUTE from public and anon on group-3 definers", () => {
  test.each([...GROUP_3_REVOKE_TARGETS])(
    "revoke execute on public.$name($args) from public, anon",
    ({ name, args }) => {
      expect(
        hasRevokeFromPublicAndAnon(name, args),
        `expected: revoke execute on function public.${name}(${args}) from public, anon;`,
      ).toBe(true);
    },
  );

  test("every revoke line names both public and anon", () => {
    // Catches group-2 hygiene revokes that are not in the group-3 each-table.
    const revokes = migration96Code.match(/revoke\s+execute\s+on\s+function[^;]+;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const line of revokes) {
      expect(line, line).toMatch(new RegExp(BOTH_GRANTEES, "i"));
    }
  });

  test.each([...GROUP_1_EXEMPT])("does not revoke %s (RLS helper exemption)", (name) => {
    // Strip comments first so the header can name these without failing.
    expect(migration96Code).not.toMatch(
      new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${name}\\b`, "i"),
    );
  });

  test("privileges only — no create or replace function", () => {
    expect(migration96Code).not.toMatch(/create\s+or\s+replace\s+function/i);
  });

  test("privileges only — no grant", () => {
    expect(migration96Code).not.toMatch(/\bgrant\b/i);
  });
});
