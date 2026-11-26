import { describe, expect, test, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

const { runSalariesJob } = await import("./salariesJob");

describe("runSalariesJob", () => {
  test("generates the month that `asOf` falls in, not the month it runs in", async () => {
    // A late or replayed tick must produce the month it was meant to. Deriving
    // the period from the database's current_date instead would silently skip a
    // month whenever a tick slipped past a month boundary.
    rpc.mockResolvedValueOnce({ data: [{ id: "a" }, { id: "b" }], error: null });

    const result = await runSalariesJob("2026-03-31T23:00:00Z");

    expect(rpc).toHaveBeenCalledWith("generate_salaries_for_month", {
      p_year: 2026,
      p_month: 3,
    });
    expect(result).toEqual({ created: 2, year: 2026, month: 3 });
  });

  test("reports zero created when every salary already exists", async () => {
    // `on conflict do nothing` returns no rows on a second run — that is the
    // idempotency showing through, not a failure.
    rpc.mockResolvedValueOnce({ data: [], error: null });
    const result = await runSalariesJob("2026-05-10T00:00:00Z");
    expect(result.created).toBe(0);
  });

  test("surfaces a database error rather than reporting success", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });
    await expect(runSalariesJob("2026-05-10T00:00:00Z")).rejects.toThrow(/permission denied/);
  });
});
