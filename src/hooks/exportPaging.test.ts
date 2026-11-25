/**
 * كل تصديرات CSV تُرجع البيانات كاملة، لا أول صفحة منها.
 *
 * Audit H11: eight exports each asked for one fixed page — 500 rows for six of
 * them, a 5000 that PostgREST silently clipped to 1000 for the other two — and
 * handed the short result straight to the CSV writer with no banner and no
 * error. Six of the eight drifted that way because nothing asserted otherwise.
 * These tests are that assertion: every export is driven against a source that
 * holds MORE rows than its old cap, and must come back whole.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => from(table),
    rpc: (name: string, args: Record<string, unknown>) => rpc(name, args),
  },
}));

const { fetchBuildingExport } = await import("@/hooks/useBuildings");
const { fetchContractExport } = await import("@/hooks/useContracts");
const { fetchDepositExport } = await import("@/hooks/useDeposits");
const { fetchExpenseExport } = await import("@/hooks/useExpenses");
const { fetchMaintenanceExport } = await import("@/hooks/useMaintenance");
const { fetchPropertyExport } = await import("@/hooks/useProperties");
const { fetchTenantExport } = await import("@/hooks/useTenants");
const { fetchUnitExport } = await import("@/hooks/useUnits");

/** أكبر من كل السقوف القديمة (500 و1000) بصف واحد على الأقل. */
const TOTAL_ROWS = 1250;

/**
 * مصدر صفحي لجدول واحد: يردّ على `range(from, to)` بالشريحة المطلوبة فقط.
 *
 * The cap mirrors PostgREST's own behaviour — a request for a wider range than
 * the server allows is answered with a short page and no error, which is the
 * exact shape that made the old `pageSize: 5000` a silent 1000.
 */
function pagedTable(rows: readonly unknown[], serverCap = 1000) {
  const builder: Record<string, unknown> = {};
  let slice: unknown[] = [];
  for (const method of ["select", "eq", "in", "or", "is", "not", "ilike", "order", "gt", "lt"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.range = vi.fn((start: number, end: number) => {
    const width = Math.min(end - start + 1, serverCap);
    slice = rows.slice(start, start + width);
    return builder;
  });
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: slice, error: null, count: rows.length }).then(resolve);
  return builder;
}

/** جدول علاقات فارغ: التصدير يطلبه لكنه ليس موضوع الاختبار. */
function emptyTable() {
  const builder: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "in",
    "or",
    "is",
    "not",
    "ilike",
    "order",
    "range",
    "gt",
    "gte",
    "lt",
    "lte",
    "limit",
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
  return builder;
}

/** صفوف بمعرّفات متتابعة — المعرّف وحده يكفي لإثبات أن كل صفحة وصلت. */
function rowsFor(table: string): unknown[] {
  return Array.from({ length: TOTAL_ROWS }, (_, index) => ({
    id: `${table}-${index}`,
    property_id: null,
    unit_id: null,
    tenant_id: null,
    category_id: null,
    contract_id: null,
    archived_at: null,
  }));
}

/** يوجّه الجدول المطلوب إلى المصدر الصفحي وكل ما عداه إلى جدول فارغ. */
function routeTables(subject: string, serverCap = 1000) {
  const rows = rowsFor(subject);
  from.mockImplementation((table: string) =>
    table === subject ? pagedTable(rows, serverCap) : emptyTable(),
  );
  return rows;
}

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [], error: null });
});

describe("every CSV export returns the whole dataset, not its first page", () => {
  const cases = [
    { name: "buildings", table: "buildings", run: () => fetchBuildingExport({}) },
    { name: "contracts", table: "contracts", run: () => fetchContractExport({}) },
    { name: "deposits", table: "deposits", run: () => fetchDepositExport({}) },
    { name: "expenses", table: "expenses", run: () => fetchExpenseExport({}) },
    { name: "maintenance", table: "maintenance_requests", run: () => fetchMaintenanceExport({}) },
    { name: "properties", table: "properties", run: () => fetchPropertyExport({}) },
    { name: "tenants", table: "tenants", run: () => fetchTenantExport({}) },
    { name: "units", table: "units", run: () => fetchUnitExport({}) },
  ] as const;

  for (const { name, table, run } of cases) {
    it(`${name}: ${TOTAL_ROWS} rows come back whole, past the old 500/1000 cap`, async () => {
      routeTables(table);

      const result = await run();

      expect(result.items).toHaveLength(TOTAL_ROWS);
      expect(result.count).toBe(TOTAL_ROWS);
      // Not flagged: the data ended on its own count, the ceiling never fired.
      expect(result.truncated).toBe(false);
    });

    it(`${name}: pages again when the server caps a page below the request`, async () => {
      // serverCap 400 forces at least four round trips for 1250 rows. Treating
      // a short page as the last one is exactly the bug being guarded.
      routeTables(table, 400);

      const result = await run();

      expect(result.items).toHaveLength(TOTAL_ROWS);
    });
  }
});
