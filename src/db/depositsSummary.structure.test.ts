import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/81_deposits_summary_rpc.sql"),
  "utf8",
);

describe("migration 81 deposits summary RPC", () => {
  test("defines get_deposits_summary", () => {
    expect(migration).toMatch(/create or replace function public\.get_deposits_summary\(/);
  });

  test("revokes execute from public and anon", () => {
    expect(migration).toMatch(
      /revoke all on function public\.get_deposits_summary\([^)]*\)\s+from public,\s*anon/i,
    );
  });

  test("grants execute to authenticated and service_role", () => {
    expect(migration).toMatch(/to authenticated,\s*service_role/);
  });

  test("opens with a deposits.read permission guard", () => {
    expect(migration).toMatch(/has_permission\(auth\.uid\(\),\s*'deposits\.read'\)/);
    expect(migration).toMatch(/Permission denied/);
  });
});

describe("deposits summary wiring", () => {
  test("hook calls get_deposits_summary", () => {
    const source = readFileSync(resolve(process.cwd(), "src/hooks/useDepositsSummary.ts"), "utf8");
    expect(source).toContain('.rpc("get_deposits_summary"');
  });

  test("admin.deposits mounts SummaryCards", () => {
    const source = readFileSync(resolve(process.cwd(), "src/routes/admin.deposits.tsx"), "utf8");
    expect(source).toContain('from "@/components/admin/SummaryCards"');
    expect(source).toContain("<SummaryCards");
    expect(source).toContain("useDepositsSummary");
  });
});
