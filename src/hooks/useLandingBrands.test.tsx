/**
 * @vitest-environment jsdom
 *
 * يتحقق من أن خطافات العلامات التجارية والعقود في صفحة الهبوط تُقيَّد بشركة المضيف
 * ولا تُنفِّذ استعلاماً عندما يغيب معرّف الشركة (T195).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getLandingCompanyId = vi.fn<() => Promise<string | null>>();
vi.mock("@/company/rootPageDecision", () => ({
  getLandingCompanyId: () => getLandingCompanyId(),
}));

const eqCalls: Array<{ table: string; col: string; val: unknown }> = [];
const fromTables: string[] = [];

function makeChain(table: string, result: { data: unknown; error: unknown }) {
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      eqCalls.push({ table, col, val });
      return chain;
    },
    in: () => chain,
    order: () => chain,
    then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
  };
  return chain;
}

const tableResults: Record<string, { data: unknown; error: unknown }> = {
  commercial_brands: { data: [{ id: "b1", company_id: "comp-1", name_ar: "مقهى" }], error: null },
  commercial_brand_contracts: {
    data: [{ brand_id: "b1", contract_id: "c1" }],
    error: null,
  },
  contracts: { data: [{ id: "c1", code: "C-001", tenant_id: "t1" }], error: null },
  tenants: { data: [{ id: "t1", name: "Tenant A" }], error: null },
  contract_units: { data: [{ contract_id: "c1", unit_id: "u1" }], error: null },
  units: { data: [{ id: "u1", name: "Unit 1" }], error: null },
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      fromTables.push(table);
      return makeChain(table, tableResults[table] ?? { data: [], error: null });
    },
  },
}));

import {
  useActiveContractOptions,
  useBrandContractLinks,
  useLandingBrands,
} from "@/hooks/useLandingBrands";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(useHook: () => { data?: unknown; fetchStatus: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: { data?: unknown; fetchStatus: string } = { fetchStatus: "idle" };

  function Harness() {
    latest = useHook();
    return null;
  }

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
  });

  return { getLatest: () => latest };
}

beforeEach(() => {
  eqCalls.length = 0;
  fromTables.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useLandingBrands host-company scoping", () => {
  it.each([
    {
      name: "useLandingBrands",
      useHook: useLandingBrands,
      expectedTables: ["commercial_brands"],
    },
    {
      name: "useBrandContractLinks",
      useHook: useBrandContractLinks,
      expectedTables: ["commercial_brand_contracts"],
    },
    {
      name: "useActiveContractOptions",
      useHook: useActiveContractOptions,
      expectedTables: ["contracts", "tenants", "contract_units", "units"],
    },
  ])("$name filters every query by the host company id", async ({ useHook, expectedTables }) => {
    getLandingCompanyId.mockResolvedValue("comp-1");
    const { getLatest } = mount(useHook);

    await vi.waitFor(() => {
      expect(getLatest().data).toBeDefined();
    });

    for (const table of expectedTables) {
      expect(eqCalls).toContainEqual({ table, col: "company_id", val: "comp-1" });
    }
  });

  it("stays disabled and does not query Supabase when no host company exists", async () => {
    getLandingCompanyId.mockResolvedValue(null);
    const { getLatest } = mount(useLandingBrands);

    await vi.waitFor(() => {
      expect(getLandingCompanyId).toHaveBeenCalled();
    });

    expect(getLatest().fetchStatus).toBe("idle");
    expect(fromTables).toEqual([]);
  });
});
