import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Tables } from "@/integrations/supabase/database.types";

const from = vi.fn();
const rpc = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => from(table),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const { isInsuranceDeleteForbidden, syncContractInsurance } =
  await import("@/hooks/useContractInsurance");

type Contract = Tables<"contracts">;

/**
 * عقد بالحد الأدنى من الحقول التي يقرأها `syncContractInsurance`.
 */
function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "contract-1",
    tenant_id: "tenant-1",
    deposit: 0,
    start_date: "2026-01-01",
    ...overrides,
  } as Contract;
}

/** منشئ PostgREST بسيط: كل مرشّح يعيد `this`، والانتظار يحلّ النتيجة. */
function stub(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit", "update", "insert"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});

describe("syncContractInsurance", () => {
  test("a positive→zero transition calls the RPC and returns deleted", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    const outcome = await syncContractInsurance({
      contract: contract({ deposit: 0 }),
      previousAmount: 3500,
    });

    expect(outcome).toBe("deleted");
    expect(rpc).toHaveBeenCalledWith("delete_contract_insurance", {
      p_contract_id: "contract-1",
    });
    expect(from).not.toHaveBeenCalled();
  });

  test("zero→zero returns unchanged and calls nothing", async () => {
    const outcome = await syncContractInsurance({
      contract: contract({ deposit: 0 }),
      previousAmount: 0,
    });

    expect(outcome).toBe("unchanged");
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  test("3500→4000 still updates the existing holding", async () => {
    const existing = stub({ data: { id: "ins-1", amount: 3500 }, error: null });
    const update = stub({ data: null, error: null });
    from.mockImplementationOnce(() => existing).mockImplementationOnce(() => update);

    const outcome = await syncContractInsurance({
      contract: contract({ deposit: 4000 }),
      previousAmount: 3500,
    });

    expect(outcome).toBe("updated");
    expect(rpc).not.toHaveBeenCalled();
    expect(from.mock.calls.map(([table]) => table)).toEqual([
      "insurance_payments",
      "insurance_payments",
    ]);
    expect(update.update).toHaveBeenCalledWith({ amount: 4000 });
    expect(update.eq).toHaveBeenCalledWith("id", "ins-1");
  });

  test("positive→zero with no holding is unchanged, not a failure", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    const outcome = await syncContractInsurance({
      contract: contract({ deposit: 0 }),
      previousAmount: 3500,
    });

    expect(outcome).toBe("unchanged");
    expect(rpc).toHaveBeenCalledOnce();
  });
});

describe("isInsuranceDeleteForbidden", () => {
  test("recognises the RPC's typed error message", () => {
    expect(
      isInsuranceDeleteForbidden({ message: "insurance_delete_forbidden", code: "42501" }),
    ).toBe(true);
    expect(isInsuranceDeleteForbidden(new Error("boom"))).toBe(false);
  });
});
