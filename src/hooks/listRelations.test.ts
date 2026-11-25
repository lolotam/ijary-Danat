import { beforeEach, describe, expect, test, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (name: string, args: Record<string, unknown>) => rpc(name, args) },
}));

const { fetchContractListRelations, fetchTenantListRelations } =
  await import("@/hooks/listRelations");

beforeEach(() => rpc.mockReset());

describe("fetchContractListRelations", () => {
  test("sends every id in one call and reshapes brands and overdue for the page", async () => {
    rpc.mockResolvedValue({
      data: {
        tenants: [{ id: "t1" }],
        contract_units: [{ contract_id: "c1", unit_id: "u1", monthly_amount: 100, line_order: 1 }],
        units: [{ id: "u1" }],
        properties: [],
        concessions: [],
        brands: [{ contract_id: "c1", logo_path: "logos/a.png", cover_path: null }],
        overdue_contract_ids: ["c2"],
      },
      error: null,
    });

    const relations = await fetchContractListRelations(["c1", "c2"]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("contract_list_relations", { p_contract_ids: ["c1", "c2"] });
    expect(relations.brandByContract.get("c1")).toEqual({ logoUrl: "logos/a.png", cardUrl: null });
    expect([...relations.overdueContractIds]).toEqual(["c2"]);
    expect(relations.contractUnits).toHaveLength(1);
  });

  test("a missing key reads as an empty list, not a crash", async () => {
    rpc.mockResolvedValue({ data: { tenants: [{ id: "t1" }] }, error: null });

    const relations = await fetchContractListRelations(["c1"]);

    expect(relations.units).toEqual([]);
    expect(relations.overdueContractIds.size).toBe(0);
  });

  test("an RPC error reaches the caller instead of rendering an empty list", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("permission denied") });

    await expect(fetchContractListRelations(["c1"])).rejects.toThrow("permission denied");
  });
});

describe("fetchTenantListRelations", () => {
  test("passes tenant ids and keeps (tenant, contract) overdue pairs", async () => {
    rpc.mockResolvedValue({
      data: {
        contracts: [{ id: "c1", tenant_id: "t1" }],
        contract_units: [],
        units: [],
        properties: [],
        brands: [],
        overdue: [{ tenant_id: "t1", contract_id: "c1" }],
      },
      error: null,
    });

    const relations = await fetchTenantListRelations(["t1"]);

    expect(rpc).toHaveBeenCalledWith("tenant_list_relations", { p_tenant_ids: ["t1"] });
    expect(relations.overdue).toEqual([{ tenant_id: "t1", contract_id: "c1" }]);
    expect(relations.brandByContract.size).toBe(0);
  });
});
