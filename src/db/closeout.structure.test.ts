import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Structural proof that migration 84 closes the Supabase default-privilege
 * footgun and keeps the close-out tables shaped as designed, when Docker is
 * unavailable for `bun run test:sql`. Does not re-implement the schema — it
 * asserts the shipped SQL contains the revokes, grants, policies and CHECKs.
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/84_contract_closeouts.sql"),
  "utf8",
);

/**
 * The migration with SQL comments stripped.
 *
 * The negative assertions below must judge the shipped SQL, not the prose that
 * documents it. Run against the raw text, they made the header unable to state
 * "this migration drops no function" without failing its own test — so the test
 * was shaping the documentation instead of checking the code. Strip first, then
 * assert, and the header is free to say exactly what it means.
 */
const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const TABLES = [
  "contract_closeouts",
  "contract_closeout_deductions",
  "contract_closeout_invoice_actions",
  "contract_operational_events",
] as const;

describe("migration 84 contract close-out schema structure", () => {
  test.each([...TABLES])("%s revokes all from public, anon, authenticated", (table) => {
    // Named explicitly: `revoke ... from public` does not reach anon (migration 78).
    expect(migrationCode).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated`,
        "i",
      ),
    );
  });

  test.each([...TABLES])("%s grants all to service_role", (table) => {
    expect(migrationCode).toMatch(
      new RegExp(`grant\\s+all\\s+on\\s+public\\.${table}\\s+to\\s+service_role`, "i"),
    );
  });

  test("contract_closeouts grants select, insert, update — not delete — to authenticated", () => {
    expect(migrationCode).toMatch(
      /grant\s+select,\s*insert,\s*update\s+on\s+public\.contract_closeouts\s+to\s+authenticated/i,
    );
    // Negative: no delete grant to authenticated on the parent close-out row.
    expect(migrationCode).not.toMatch(
      /grant\s+[^;]*\bdelete\b[^;]*on\s+public\.contract_closeouts\s+to\s+authenticated/i,
    );
  });

  test("deductions and invoice_actions grant delete to authenticated", () => {
    expect(migrationCode).toMatch(
      /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+public\.contract_closeout_deductions\s+to\s+authenticated/i,
    );
    expect(migrationCode).toMatch(
      /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+public\.contract_closeout_invoice_actions\s+to\s+authenticated/i,
    );
  });

  test("contract_operational_events grants only select to authenticated", () => {
    expect(migrationCode).toMatch(
      /grant\s+select\s+on\s+public\.contract_operational_events\s+to\s+authenticated/i,
    );
    expect(migrationCode).not.toMatch(
      /grant\s+[^;]*\b(insert|update|delete)\b[^;]*on\s+public\.contract_operational_events\s+to\s+authenticated/i,
    );
  });

  test("contract_operational_events has no authenticated insert/update/delete policy", () => {
    // service_role_all is for service_role only; the absence of authenticated
    // write policies IS the deny for staff clients.
    const eventsPolicies = [
      ...migrationCode.matchAll(
        /create\s+policy\s+(\w+)\s+on\s+public\.contract_operational_events\s+for\s+(\w+)\s+to\s+(\w+)/gi,
      ),
    ];
    const names = eventsPolicies.map((m) => ({
      name: m[1],
      cmd: m[2].toLowerCase(),
      role: m[3].toLowerCase(),
    }));

    expect(names.some((p) => p.cmd === "select" && p.role === "authenticated")).toBe(true);
    expect(
      names.some(
        (p) =>
          p.role === "authenticated" &&
          (p.cmd === "insert" || p.cmd === "update" || p.cmd === "delete"),
      ),
    ).toBe(false);
  });

  test("every create policy is preceded by drop policy if exists", () => {
    const creates = [...migrationCode.matchAll(/create\s+policy\s+(\w+)\s+on\s+public\.(\w+)/gi)];
    expect(creates.length).toBeGreaterThan(0);

    for (const m of creates) {
      const policy = m[1];
      const table = m[2];
      const drop = new RegExp(
        `drop\\s+policy\\s+if\\s+exists\\s+${policy}\\s+on\\s+public\\.${table}`,
        "i",
      );
      const dropIdx = migrationCode.search(drop);
      const createIdx = m.index ?? -1;
      expect(dropIdx, `missing drop before create policy ${policy}`).toBeGreaterThanOrEqual(0);
      expect(dropIdx).toBeLessThan(createIdx);
    }
  });

  test("partial unique index enforces one draft per contract", () => {
    expect(migrationCode).toMatch(
      /create\s+unique\s+index\s+if\s+not\s+exists\s+closeouts_one_draft_per_contract\s+on\s+public\.contract_closeouts\s*\(\s*contract_id\s*\)\s*where\s+status\s*=\s*'draft'/i,
    );
  });

  test("outcome CHECK lists exactly keep_terminated, freeze, archive", () => {
    // Match the column CHECK on outcome (not archive_tenant's reference to 'archive').
    const outcomeCheck = migrationCode.match(
      /outcome\s+text\s+not\s+null\s+check\s*\(\s*outcome\s+in\s*\(([^)]+)\)\s*\)/i,
    );
    expect(outcomeCheck, "outcome CHECK not found").not.toBeNull();
    const listed = (outcomeCheck![1].match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
    expect(listed.sort()).toEqual(["archive", "freeze", "keep_terminated"].sort());
  });

  test("defines all four tables", () => {
    for (const table of TABLES) {
      expect(migrationCode).toMatch(
        new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}`, "i"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Migrations 85 / 86 — refund reversal + invoice write-off / dispute
// ---------------------------------------------------------------------------

const migration85 = readFileSync(
  resolve(process.cwd(), "db/migrations/85_refunds_reversal.sql"),
  "utf8",
);
const migration85Code = migration85.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const migration86 = readFileSync(
  resolve(process.cwd(), "db/migrations/86_invoice_dispute_and_write_off.sql"),
  "utf8",
);
const migration86Code = migration86.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 85 refunds reversal structure", () => {
  test("revokes new functions from public and anon", () => {
    for (const fn of ["next_refund_code", "reverse_refund", "void_refund"] as const) {
      expect(migration85Code).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\([^)]*\\)\\s+from\\s+public,\\s*anon`,
          "i",
        ),
      );
    }
  });

  test("refunds_delete_permitted requires status = 'draft'", () => {
    // The production incident: a posted refund was hard-deleted. RLS is the boundary.
    expect(migration85Code).toMatch(
      /create\s+policy\s+refunds_delete_permitted\s+on\s+public\.refunds[\s\S]*?status\s*=\s*'draft'/i,
    );
  });

  test("re-issues both get_budget_summary and get_payments_summary", () => {
    expect(migration85Code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.get_budget_summary\s*\(/i,
    );
    expect(migration85Code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.get_payments_summary\s*\(/i,
    );
    // Refund predicate on both (aliases r and x respectively).
    expect(migration85Code).toMatch(
      /r\.status\s*=\s*'posted'\s+and\s+r\.reversal_of_id\s+is\s+null/i,
    );
    expect(migration85Code).toMatch(
      /x\.status\s*=\s*'posted'\s+and\s+x\.reversal_of_id\s+is\s+null/i,
    );
  });
});

describe("migration 86 invoice dispute and write-off structure", () => {
  test("revokes new functions from public and anon", () => {
    for (const fn of [
      "write_off_invoice",
      "set_invoice_dispute",
      "clear_invoice_dispute",
    ] as const) {
      expect(migration86Code).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\([^)]*\\)\\s+from\\s+public,\\s*anon`,
          "i",
        ),
      );
    }
  });

  test("write_off_invoice does not write paid", () => {
    // paid must stay untouched so balance remains the written-off amount.
    expect(migration86Code).not.toMatch(/update\s+.*set\s+paid/i);
  });
});

// ---------------------------------------------------------------------------
// Migration 87 — close-out RPCs
// ---------------------------------------------------------------------------

const migration87 = readFileSync(
  resolve(process.cwd(), "db/migrations/87_contract_closeout_rpcs.sql"),
  "utf8",
);
const migration87Code = migration87.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 87 contract close-out RPCs structure", () => {
  test("32. contains no update public.units", () => {
    // Unit release is migration 76's trigger. A direct write is rejected by
    // trg_unit_enforce_derived_status and would risk deadlocks if locked first.
    expect(migration87Code).not.toMatch(/update\s+public\.units/i);
  });

  test("33. close_out_contract locks contracts → tenants → invoices; no units lock", () => {
    const fnMatch = migration87Code.match(
      /create\s+or\s+replace\s+function\s+public\.close_out_contract[\s\S]*?(?=create\s+or\s+replace\s+function\s+public\.cancel_contract_closeout|$)/i,
    );
    expect(fnMatch, "close_out_contract not found").not.toBeNull();
    const body = fnMatch![0];

    const forUpdate = [...body.matchAll(/for\s+update/gi)];
    expect(forUpdate.length).toBeGreaterThanOrEqual(3);

    const contractsLock = body.search(
      /from\s+public\.contracts\s+c\s+where\s+c\.id\s*=\s*p_contract_id[\s\S]*?for\s+update/i,
    );
    const tenantsLock = body.search(
      /from\s+public\.tenants\s+t\s+where\s+t\.id\s*=\s*v_contract\.tenant_id\s+for\s+update/i,
    );
    const invoicesLock = body.search(
      /from\s+public\.invoices\s+i\s+where\s+i\.contract_id\s*=\s*p_contract_id[\s\S]*?for\s+update/i,
    );

    expect(contractsLock, "contracts for update").toBeGreaterThanOrEqual(0);
    expect(tenantsLock, "tenants for update").toBeGreaterThanOrEqual(0);
    expect(invoicesLock, "invoices for update").toBeGreaterThanOrEqual(0);
    expect(contractsLock).toBeLessThan(tenantsLock);
    expect(tenantsLock).toBeLessThan(invoicesLock);

    // No units lock in close_out_contract.
    expect(body).not.toMatch(/from\s+public\.units[\s\S]{0,80}for\s+update/i);
  });

  test("34. calls public.write_audit( at least once", () => {
    expect(migration87Code).toMatch(/public\.write_audit\s*\(/i);
  });

  test("35. calls public.apply_payment_allocation( (settle reuses tested state machine)", () => {
    expect(migration87Code).toMatch(/public\.apply_payment_allocation\s*\(/i);
  });

  test("36. has no set paid / paid = write against invoices", () => {
    // Settle goes through apply_payment_allocation; write_off leaves paid alone.
    expect(migration87Code).not.toMatch(/update\s+public\.invoices[\s\S]{0,200}\bpaid\s*=/i);
    expect(migration87Code).not.toMatch(/\bset\s+paid\b/i);
  });

  test("37. every function in 87 has revoke all ... from public, anon", () => {
    const functions = [
      ...migration87Code.matchAll(
        /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([^)]*)\)/gi,
      ),
    ];
    expect(functions.length).toBeGreaterThanOrEqual(4);

    for (const m of functions) {
      const name = m[1];
      // Each function's revoke may span a multi-line signature; match by name.
      expect(migration87Code, `missing revoke for ${name}`).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\)\\s*from\\s+public,\\s*anon`,
          "i",
        ),
      );
    }
  });
});
