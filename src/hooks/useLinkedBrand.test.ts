import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => from(table) },
}));

const { brandForSelectedContract, brandsForContracts, linkedBrandsByContract } =
  await import("@/hooks/useLinkedBrand");

/**
 * سلسلة PostgREST وهمية: limit/maybeSingle يطويان الصفوف كما يفعل الخادم.
 *
 * A naive thenable that ignores those calls would let the old `.limit(1).maybeSingle()`
 * path still pass a two-brand assertion.
 */
function stub(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.limit = vi.fn((count: number) => {
    const rows = Array.isArray(result.data) ? result.data.slice(0, count) : result.data;
    return stub({ data: rows, error: result.error });
  });
  builder.maybeSingle = vi.fn(() => {
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    return stub({ data: rows[0] ?? null, error: result.error });
  });
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

const alpha = {
  id: "brand-a",
  slug: "alpha",
  name_ar: "ألفا",
  name_en: "Alpha",
  links: [{ contract_id: "c-shop-a" }],
  logo: { storage_path: "/brands/alpha.png" },
};

const beta = {
  id: "brand-b",
  slug: "beta",
  name_ar: "بيتا",
  name_en: "Beta",
  links: [{ contract_id: "c-shop-b" }],
  logo: { storage_path: "/brands/beta.png" },
};

beforeEach(() => {
  from.mockReset();
});

describe("linkedBrandsByContract", () => {
  it("keys each brand by its own contract, so two shops stay distinct", () => {
    const byContract = linkedBrandsByContract([alpha, beta]);
    expect(byContract.get("c-shop-a")?.logoUrl).toBe("/brands/alpha.png");
    expect(byContract.get("c-shop-b")?.logoUrl).toBe("/brands/beta.png");
    expect(byContract.get("c-shop-a")?.logoUrl).not.toBe(byContract.get("c-shop-b")?.logoUrl);
  });

  it("omits a contract with no brand rather than filling it from a sibling", () => {
    const byContract = linkedBrandsByContract([alpha]);
    expect(byContract.get("c-shop-a")?.logoUrl).toBe("/brands/alpha.png");
    expect(byContract.has("c-shop-b")).toBe(false);
    expect(byContract.get("c-shop-b")).toBeUndefined();
  });

  /**
   * The point of migration 162. Before it, `contract_id` was one column, so a
   * shop occupying two leases could carry its logo on only one of them and the
   * other silently showed nothing.
   */
  it("puts one brand on every contract it is linked to", () => {
    const gamma = {
      ...alpha,
      id: "brand-c",
      links: [{ contract_id: "c-one" }, { contract_id: "c-two" }, { contract_id: "c-three" }],
    };

    const byContract = linkedBrandsByContract([gamma]);

    expect([...byContract.keys()].sort()).toEqual(["c-one", "c-three", "c-two"]);
    for (const contractId of ["c-one", "c-two", "c-three"]) {
      expect(byContract.get(contractId)?.id).toBe("brand-c");
      // Each entry names the contract it was keyed by, not the brand's "first"
      // one — the portal logo card reads this back to decide what to show.
      expect(byContract.get(contractId)?.contractId).toBe(contractId);
    }
  });

  it("keeps the first brand when two claim the same contract", () => {
    const first = { ...alpha, id: "brand-first", links: [{ contract_id: "c-shared" }] };
    const second = { ...beta, id: "brand-second", links: [{ contract_id: "c-shared" }] };

    // Rows arrive in display_order, so the first row is the intended winner.
    expect(linkedBrandsByContract([first, second]).get("c-shared")?.id).toBe("brand-first");
  });

  it("ignores a brand with no links at all", () => {
    expect(linkedBrandsByContract([{ ...alpha, links: [] }]).size).toBe(0);
  });
});

describe("brandsForContracts", () => {
  it("returns every active brand, not the first row PostgREST happens to pick", async () => {
    from.mockImplementationOnce(() => stub({ data: [alpha, beta], error: null }));

    const byContract = await brandsForContracts(["c-shop-a", "c-shop-b"]);

    expect(byContract.size).toBe(2);
    expect(byContract.get("c-shop-a")?.id).toBe("brand-a");
    expect(byContract.get("c-shop-b")?.id).toBe("brand-b");
  });

  it("queries nothing when the tenant has no contracts", async () => {
    expect((await brandsForContracts([])).size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  /**
   * The one thing a mocked PostgREST client genuinely cannot check for itself.
   *
   * The contract link is an embedded relation now, and PostgREST resolves an
   * embedded filter against the ALIAS the select gave it. Filtering
   * `commercial_brand_contracts.contract_id` by table name instead returns
   * every active brand in the database with no error — every tenant would show
   * whichever storefront sorted first. Since the stub answers regardless of the
   * filter, the filter string itself is the assertion.
   */
  it("filters on the embed's alias and selects it as an inner join", async () => {
    const query = stub({ data: [alpha], error: null });
    from.mockImplementationOnce(() => query);

    await brandsForContracts(["c-shop-a"]);

    expect(query.in).toHaveBeenCalledWith("links.contract_id", ["c-shop-a"]);
    const [selected] = (query.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(selected).toContain("links:commercial_brand_contracts!inner");
  });
});

describe("brandForSelectedContract", () => {
  const byContract = linkedBrandsByContract([alpha, beta]);

  it("follows the currently selected contract, not the first brand in the map", () => {
    expect(brandForSelectedContract(byContract, "c-shop-b")?.id).toBe("brand-b");
    expect(brandForSelectedContract(byContract, "c-shop-a")?.id).toBe("brand-a");
  });

  it("returns null when that contract has no brand, instead of falling back", () => {
    expect(brandForSelectedContract(byContract, "c-missing")).toBeNull();
    expect(brandForSelectedContract(undefined, "c-shop-a")).toBeNull();
    expect(brandForSelectedContract(byContract, null)).toBeNull();
  });
});
