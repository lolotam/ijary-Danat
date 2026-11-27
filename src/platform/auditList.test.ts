import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Supabase هو الحدّ الخارجي الوحيد هنا؛ كل ما عداه كود حقيقي.
 *
 * The reader builds the PostgREST query in `auditList.ts`; a mocked internal
 * helper would let a broken filter or a wrong page range pass unnoticed.
 */
const db = vi.hoisted(() => ({
  table: "",
  select: [] as unknown[],
  filters: [] as Array<[string, string, unknown]>,
  order: [] as unknown[],
  range: [] as number[],
  result: {
    data: [] as unknown[] | null,
    error: null as { message: string } | null,
    count: 0 as number | null,
  },
}));

vi.mock("@/integrations/supabase/client", () => {
  const builder = {
    select(columns: unknown, options: unknown) {
      db.select = [columns, options];
      return builder;
    },
    eq(column: string, value: unknown) {
      db.filters.push(["eq", column, value]);
      return builder;
    },
    like(column: string, value: unknown) {
      db.filters.push(["like", column, value]);
      return builder;
    },
    order(column: unknown, options: unknown) {
      db.order = [column, options];
      return builder;
    },
    async range(from: number, to: number) {
      db.range = [from, to];
      return db.result;
    },
  };

  return {
    supabase: {
      from(table: string) {
        db.table = table;
        return builder;
      },
    },
  };
});

import { auditListSchema, listPlatformAudit } from "./auditList";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

/** يعيد ضبط حالة عميل Supabase الوهمي بين الاختبارات. */
beforeEach(() => {
  db.table = "";
  db.select = [];
  db.filters = [];
  db.order = [];
  db.range = [];
  db.result = { data: [], error: null, count: 0 };
});

describe("platform audit list", () => {
  it("reads the requested page newest-first with an exact total", async () => {
    const rows = [
      {
        id: "row-1",
        actor_id: "admin-1",
        company_id: COMPANY_ID,
        action: "company.create",
        entity: "company",
        entity_id: COMPANY_ID,
        before: null,
        after: { name: "Acme" },
        ip: null,
        request_id: null,
        created_at: "2026-11-27T10:00:00Z",
      },
    ];
    db.result = { data: rows, error: null, count: 31 };

    const page = await listPlatformAudit({ page: 2, pageSize: 25 });

    expect(db.table).toBe("platform_audit_log");
    expect(db.select).toEqual(["*", { count: "exact" }]);
    expect(db.order).toEqual(["created_at", { ascending: false }]);
    expect(db.range).toEqual([25, 49]);
    expect(page).toEqual({ rows, total: 31, page: 2, pageSize: 25 });
  });

  it.each([
    {
      name: "no optional filter",
      input: {},
      filters: [] as Array<[string, string, unknown]>,
    },
    {
      name: "a company filter",
      input: { companyId: COMPANY_ID },
      filters: [["eq", "company_id", COMPANY_ID]] as Array<[string, string, unknown]>,
    },
    {
      name: "an action prefix",
      input: { actionPrefix: "company" },
      filters: [["like", "action", "company.%"]] as Array<[string, string, unknown]>,
    },
    {
      name: "both filters together",
      input: { companyId: COMPANY_ID, actionPrefix: "user" },
      filters: [
        ["eq", "company_id", COMPANY_ID],
        ["like", "action", "user.%"],
      ] as Array<[string, string, unknown]>,
    },
  ])("applies $name", async ({ input, filters }) => {
    await listPlatformAudit(input);
    expect(db.filters).toEqual(filters);
  });

  it("defaults to the first page and refuses an oversized page", () => {
    expect(auditListSchema.parse({})).toMatchObject({ page: 1, pageSize: 25 });
    expect(() => auditListSchema.parse({ pageSize: 101 })).toThrow();
    expect(() => auditListSchema.parse({ companyId: "not-a-uuid" })).toThrow();
  });

  it("raises when the audit log cannot be read", async () => {
    db.result = { data: null, error: { message: "permission denied" }, count: null };

    await expect(listPlatformAudit({})).rejects.toThrow(
      "Platform audit read failed: permission denied",
    );
  });
});
