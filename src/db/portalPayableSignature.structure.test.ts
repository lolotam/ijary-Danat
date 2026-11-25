import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof for migrations 97, 121 and 210 on
 * evaluate_portal_payable_invoices:
 * - Migration 97 re-issued the 1-arg form after dropping the (uuid, integer) overload.
 * - Migration 121 drops that 1-arg form and creates (uuid, uuid) with optional
 *   p_contract_id — filter and sequence renumbering live in SQL, not the client.
 * - Migration 210 drops (uuid, uuid) and creates (uuid, uuid, boolean), where
 *   p_include_hidden is a request the function downgrades for a tenant caller.
 * - Dead max-visible plumbing stays gone; revokes name both public and anon.
 *
 * Each signature change has needed its own drop: `create or replace` with a new
 * argument list creates an overload, and PostgREST answers the ambiguity with a
 * 300 rather than a readable error.
 *
 * Fast: no Docker. Complements schema.sqltest.ts and portalPayableByContract.sqltest.ts.
 */

const migration97 = readFileSync(
  resolve(process.cwd(), "db/migrations/97_portal_payable_and_reapply_align.sql"),
  "utf8",
);

const migration121 = readFileSync(
  resolve(process.cwd(), "db/migrations/121_portal_payable_by_contract.sql"),
  "utf8",
);

const migration210 = readFileSync(
  resolve(process.cwd(), "db/migrations/210_contract_hide_from_portal.sql"),
  "utf8",
);

/**
 * SQL comments stripped before negative assertions.
 *
 * Same pattern as billingSafety.structure.test.ts for migration 82: the header
 * must be free to name the things it removes without failing its own tests.
 */
const migration97Code = migration97.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const migration121Code = migration121.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const migration210Code = migration210.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/**
 * يستخرج قسم تعريف دالة من نص ترحيل.
 */
function sectionFor(source: string, name: string, label: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is not defined in ${label}`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("create or replace function public.", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** Either order, flexible whitespace: from public, anon | from anon, public */
const BOTH_GRANTEES = String.raw`from\s+(?:public\s*,\s*anon|anon\s*,\s*public)\s*`;

describe("migration 97 portal payable signature + reapply align", () => {
  test("drops the 2-arg evaluate_portal_payable_invoices before create or replace", () => {
    const dropIdx = migration97Code.search(
      /drop\s+function\s+if\s+exists\s+public\.evaluate_portal_payable_invoices\s*\(\s*uuid\s*,\s*integer\s*\)/i,
    );
    const createIdx = migration97Code.search(
      /create\s+or\s+replace\s+function\s+public\.evaluate_portal_payable_invoices\s*\(/i,
    );
    expect(dropIdx, "expected drop of (uuid, integer) form").toBeGreaterThanOrEqual(0);
    expect(createIdx, "expected create or replace").toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeLessThan(createIdx);
  });

  test("migration 97 evaluate_portal_payable_invoices takes exactly one parameter", () => {
    const section = sectionFor(migration97, "evaluate_portal_payable_invoices", "migration 97");
    // First line of the create: only p_tenant_id (no p_company_max_visible).
    const header = section.slice(0, section.indexOf("returns"));
    const params = header.match(/\(([^)]*)\)/)?.[1] ?? "";
    const names = params
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^p_tenant_id\s+uuid\b/i);
  });

  test("contains no p_company_max_visible or max_visible_unpaid_invoices", () => {
    expect(migration97Code).not.toMatch(/p_company_max_visible/i);
    expect(migration97Code).not.toMatch(/max_visible_unpaid_invoices/i);
  });

  test("every revoke names both public and anon", () => {
    const revokes = migration97Code.match(/revoke\s+execute\s+on\s+function[^;]+;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const line of revokes) {
      expect(line, line).toMatch(new RegExp(BOTH_GRANTEES, "i"));
    }
  });

  test("reapply delete is capped at current month and has no forward-year loop", () => {
    const section = sectionFor(migration97, "reapply_contract_invoices", "migration 97");
    expect(section).toMatch(/date_trunc\s*\(\s*'month'\s*,\s*current_date\s*\)/i);
    expect(section).toMatch(/backfill_contract_invoices/);
    // Forward materialisation removed — that is what inflated A/R.
    expect(section).not.toMatch(/generate_invoices_for_year/);
  });

  test("reapply archived guard still precedes the delete", () => {
    const section = sectionFor(migration97, "reapply_contract_invoices", "migration 97");
    const archiveIdx = section.search(/archived_at\s+is\s+not\s+null/i);
    const deleteIdx = section.search(/delete\s+from\s+public\.invoices/i);
    expect(archiveIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeLessThan(deleteIdx);
  });
});

describe("migration 121 portal payable by contract", () => {
  test("drops the 1-arg evaluate_portal_payable_invoices before create or replace", () => {
    const dropIdx = migration121Code.search(
      /drop\s+function\s+if\s+exists\s+public\.evaluate_portal_payable_invoices\s*\(\s*uuid\s*\)/i,
    );
    const createIdx = migration121Code.search(
      /create\s+or\s+replace\s+function\s+public\.evaluate_portal_payable_invoices\s*\(/i,
    );
    expect(dropIdx, "expected drop of (uuid) form").toBeGreaterThanOrEqual(0);
    expect(createIdx, "expected create or replace").toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeLessThan(createIdx);
  });

  test("new evaluate_portal_payable_invoices takes p_tenant_id and optional p_contract_id", () => {
    const section = sectionFor(migration121, "evaluate_portal_payable_invoices", "migration 121");
    const header = section.slice(0, section.indexOf("returns"));
    expect(header).toMatch(/p_tenant_id\s+uuid/i);
    expect(header).toMatch(/p_contract_id\s+uuid\s+default\s+null/i);
  });

  test("filters invoices by p_contract_id in SQL", () => {
    expect(migration121Code).toMatch(
      /p_contract_id\s+is\s+null\s+or\s+i\.contract_id\s*=\s*p_contract_id/i,
    );
  });

  test("rejects a contract that does not belong to the tenant", () => {
    expect(migration121Code).toMatch(/Contract does not belong to this tenant/i);
  });

  test("revoke names both public and anon on the (uuid, uuid) form", () => {
    const revokes = migration121Code.match(/revoke\s+all\s+on\s+function[^;]+;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const line of revokes) {
      expect(line, line).toMatch(new RegExp(BOTH_GRANTEES, "i"));
      expect(line).toMatch(/evaluate_portal_payable_invoices\s*\(\s*uuid\s*,\s*uuid\s*\)/i);
    }
  });
});

describe("migration 210 portal payable excludes hidden contracts", () => {
  test("drops the 2-arg evaluate_portal_payable_invoices before create or replace", () => {
    const dropIdx = migration210Code.search(
      /drop\s+function\s+if\s+exists\s+public\.evaluate_portal_payable_invoices\s*\(\s*uuid\s*,\s*uuid\s*\)/i,
    );
    const createIdx = migration210Code.search(
      /create\s+or\s+replace\s+function\s+public\.evaluate_portal_payable_invoices\s*\(/i,
    );
    expect(dropIdx, "expected drop of the (uuid, uuid) form").toBeGreaterThanOrEqual(0);
    expect(createIdx, "expected create or replace").toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeLessThan(createIdx);
  });

  test("p_include_hidden defaults to false so pre-deploy callers keep working", () => {
    const section = sectionFor(migration210, "evaluate_portal_payable_invoices", "migration 210");
    const header = section.slice(0, section.indexOf("returns"));
    expect(header).toMatch(/p_include_hidden\s+boolean\s+default\s+false/i);
  });

  /**
   * The security property, asserted on the source because the downgrade is
   * invisible to any caller that is allowed: asking to include hidden
   * contracts is not the same as being allowed to, so a crafted tenant request
   * cannot start a portal payment for a contract the office collects by hand.
   */
  test("the include flag is gated on is_staff rather than taken at face value", () => {
    const section = sectionFor(migration210, "evaluate_portal_payable_invoices", "migration 210");
    expect(section).toMatch(/v_include_hidden\s+boolean\s*:=/i);
    expect(section).toMatch(/public\.is_staff\(auth\.uid\(\)\)/);
    expect(section).toMatch(/v_include_hidden\s+or\s+not\s+coalesce\(c\.hide_from_portal/i);
  });

  /**
   * `auth.role()` and `auth.uid()` are NULL outside a PostgREST request, and
   * `true and NULL` is NULL — which plpgsql treats as not true. Without the
   * coalesce the guard read as "allow when the caller is not a tenant" and
   * behaved as "deny every service_role call"; that is how the SQL suite first
   * caught it, as an empty payable list for a superuser.
   */
  test("the staff check is null-safe for service_role and psql callers", () => {
    const section = sectionFor(migration210, "evaluate_portal_payable_invoices", "migration 210");
    expect(section).toMatch(/coalesce\(auth\.role\(\),\s*''\)\s*<>\s*'authenticated'/i);
    expect(section).toMatch(/coalesce\(public\.is_staff\(auth\.uid\(\)\),\s*false\)/i);
  });

  test("every revoke names both public and anon", () => {
    const revokes = migration210Code.match(/revoke\s+all\s+on\s+function[^;]+;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const line of revokes) {
      expect(line, line).toMatch(new RegExp(BOTH_GRANTEES, "i"));
    }
  });
});
