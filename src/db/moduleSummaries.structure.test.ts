import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { liveMigrationSql, resolveLiveMigrationFile } from "@/db/resolveLiveMigration";

/**
 * Structural proof that the five summary RPCs and the five summary hooks stay
 * in sync when Docker is unavailable for `bun run test:sql`. Does not
 * re-implement the RPCs — it asserts the shipped SQL and TypeScript call the
 * same names with the security posture the design requires.
 *
 * LIVE definition resolution: the repo uses supersede-by-number. A later
 * migration may re-issue a function (e.g. migration 85 re-issues
 * get_payments_summary). Reading a hardcoded filename tests dead SQL once that
 * happens. sectionFor() always reads the highest-numbered migration that
 * contains `create or replace function public.<name>(`.
 */

const functions = [
  "get_payments_summary",
  "get_expenses_summary",
  "get_contracts_summary",
  "get_tenants_summary",
  "get_units_summary",
] as const;

/**
 * Everything for one function: its body plus the revoke/grant that follow it,
 * ending where the next function begins.
 *
 * Deliberately NOT a fixed character window. Slicing `start + 2500` silently
 * excluded the grant for the two longest functions, so those tests failed while
 * the migration was correct — and, worse, a shorter function could have had its
 * grant deleted and still passed by borrowing the next function's.
 */
function sectionFor(name: string): string {
  const migration = liveMigrationSql(name);
  const start = migration.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is not defined in its live migration`).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf("create or replace function public.", start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

describe("module summary RPCs (live migration resolution)", () => {
  test("get_payments_summary live definition is migration 302, not 79/85/106", () => {
    // Proves the resolver itself cannot rot: once 302 re-issues the function,
    // assertions must not keep reading dead SQL from earlier migrations.
    const file = resolveLiveMigrationFile("get_payments_summary");
    expect(file.startsWith("302_")).toBe(true);
    expect(file.startsWith("106_")).toBe(false);
    expect(file.startsWith("79_")).toBe(false);
    expect(file.startsWith("85_")).toBe(false);
  });

  test.each([...functions])("defines %s", (name) => {
    expect(liveMigrationSql(name)).toMatch(
      new RegExp(`create or replace function public\\.${name}\\(`),
    );
  });

  test.each([...functions])("%s revokes execute from public and anon", (name) => {
    // Named explicitly: `revoke ... from public` does not reach anon, which
    // holds its own grant from Supabase's default privileges.
    expect(liveMigrationSql(name)).toMatch(
      new RegExp(`revoke all on function public\\.${name}\\([^)]*\\)\\s+from public,\\s*anon`, "i"),
    );
  });

  test.each([...functions])(
    "%s grants execute to authenticated, company_service, and service_role",
    (name) => {
      expect(liveMigrationSql(name)).toMatch(
        new RegExp(
          `grant execute on function public\\.${name}\\([^)]*\\)\\s+to authenticated,\\s*(?:company_service,\\s*)?service_role`,
          "i",
        ),
      );
    },
  );

  test.each([...functions])("%s opens with a has_permission guard", (name) => {
    const body = sectionFor(name);
    expect(body).toMatch(/has_permission\(auth\.uid\(\)/);
    expect(body).toMatch(/Permission denied/);
  });

  test.each([...functions])("%s is stable and security definer", (name) => {
    // security definer bypasses RLS, which is why the guard above is the whole
    // access control rather than a belt-and-braces extra.
    const body = sectionFor(name);
    expect(body).toMatch(/\bstable\b/);
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = public, auth, pg_temp/);
  });

  test("payments net excludes partial and insurance", () => {
    const body = sectionFor("get_payments_summary");
    // Partial is a readonly ledger; net is full payments minus refunds only.
    expect(body).toMatch(/v_full_total - v_refund_total/);
    expect(body).not.toMatch(/v_full_total \+ v_partial_total/);
    expect(body).not.toMatch(/v_full_total \+ v_partial_total \+ v_insurance/);
  });

  test("payments refund total counts only posted non-mirror refunds", () => {
    const body = sectionFor("get_payments_summary");
    expect(body).toMatch(/x\.status\s*=\s*'posted'/);
    expect(body).toMatch(/x\.reversal_of_id\s+is\s+null/);
  });

  test("contracts and tenants are archive-mode aware (migration 90/91)", () => {
    // Migration 90 re-issues both summaries with p_archive_mode. A bare
    // /archived_at is null/ would still match while meaning something
    // completely different (hardcoded filter vs three-way branch).
    const contracts = sectionFor("get_contracts_summary");
    const tenants = sectionFor("get_tenants_summary");

    expect(contracts).toMatch(/p_archive_mode\s+text\s+default\s+'current'/);
    expect(tenants).toMatch(/p_archive_mode\s+text\s+default\s+'current'/);

    // Three-way branch for contracts and tenants.
    expect(contracts).toMatch(/v_mode = 'all'/);
    // Migration 211 — contracts branch through `contract_is_ended` rather than
    // `archived_at` alone: close_out_contract stamps that column only for the
    // `archive` outcome, so a contract closed out as terminated was counted as
    // current. Tenants keep the plain column; nothing closes a tenant out.
    expect(contracts).toMatch(
      /v_mode = 'archived'\s+and\s+public\.contract_is_ended\(c\.archived_at, c\.state\)/,
    );
    expect(contracts).toMatch(
      /v_mode = 'current'\s+and\s+not public\.contract_is_ended\(c\.archived_at, c\.state\)/,
    );
    expect(tenants).toMatch(/v_mode = 'all'/);
    expect(tenants).toMatch(/v_mode = 'archived'\s+and\s+t\.archived_at is not null/);
    expect(tenants).toMatch(/v_mode = 'current'\s+and\s+t\.archived_at is null/);

    // Keys on the returned jsonb.
    expect(contracts).toMatch(/'archived_count'/);
    expect(tenants).toMatch(/'archived_count'/);
    expect(contracts).toMatch(/'current_count'/);
    expect(tenants).toMatch(/'current_count'/);

    // Migration 91: archived_count is computed outside the mode filter so the
    // Current tab can badge "Archived (n)". The live body must count archived
    // rows in a separate select that does not reference v_mode.
    expect(contracts).toMatch(
      /count\(\*\)\s+filter\s*\(\s*where\s+public\.contract_is_ended\(c\.archived_at, c\.state\)\s*\)/i,
    );
    expect(tenants).toMatch(
      /count\(\*\)\s+filter\s*\(\s*where\s+t\.archived_at\s+is\s+not\s+null\s*\)/i,
    );

    // Live definitions are migrations 301/302 (same 4-arg signature as 90/91/211 — no drop).
    // The 3-arg DROP lives only in 90's history; create-or-replace is correct here.
    expect(resolveLiveMigrationFile("get_contracts_summary").startsWith("301_")).toBe(true);
    expect(resolveLiveMigrationFile("get_tenants_summary").startsWith("302_")).toBe(true);
    expect(sectionFor("get_contracts_summary")).not.toMatch(/drop function if exists/i);
    expect(sectionFor("get_tenants_summary")).not.toMatch(/drop function if exists/i);
  });
});

describe("summary hooks call the matching RPC names", () => {
  const hooks: Array<{ file: string; rpc: string }> = [
    { file: "src/hooks/usePaymentsSummary.ts", rpc: "get_payments_summary" },
    { file: "src/hooks/useExpensesSummary.ts", rpc: "get_expenses_summary" },
    { file: "src/hooks/useContractsSummary.ts", rpc: "get_contracts_summary" },
    { file: "src/hooks/useTenantsSummary.ts", rpc: "get_tenants_summary" },
    { file: "src/hooks/useUnitsSummary.ts", rpc: "get_units_summary" },
  ];

  test.each(hooks)("$file calls $rpc", ({ file, rpc }) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).toContain(`.rpc("${rpc}"`);
  });
});

describe("admin list pages mount SummaryCards", () => {
  const pages = [
    "src/routes/admin.payments.tsx",
    "src/routes/admin.expenses.tsx",
    "src/routes/admin.contracts.tsx",
    "src/routes/admin.tenants.index.tsx",
    "src/routes/admin.units.index.tsx",
  ];

  test.each(pages)("%s imports and renders SummaryCards", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).toContain('from "@/components/admin/SummaryCards"');
    expect(source).toContain("<SummaryCards");
    // Cards may live inline or in the extracted group this lane owns.
    // Either path must still mount VibrantKpiCard — extraction is not deletion.
    const rendersInline = source.includes("<VibrantKpiCard");
    const rendersExtracted = source.includes('from "@/components/admin/ownedPageKpis"');
    expect(rendersInline || rendersExtracted).toBe(true);
    if (rendersExtracted) {
      const extracted = readFileSync(
        resolve(process.cwd(), "src/components/admin/ownedPageKpis.tsx"),
        "utf8",
      );
      expect(extracted).toContain("<VibrantKpiCard");
    }
  });
});
