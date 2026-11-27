/**
 * @vitest-environment jsdom
 *
 * يتحقق من أن خطاف طلبات التأجير يُقيَّد بشركة المضيف
 * ولا يُنفِّذ استعلاماً عندما يغيب معرّف الشركة (T195).
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

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      fromTables.push(table);
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          eqCalls.push({ table, col, val });
          return chain;
        },
        order: () => chain,
        range: () => chain,
        or: () => chain,
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve({
            data: [{ id: "inq-1", company_id: "comp-1", name: "Sara" }],
            error: null,
            count: 1,
          }).then(resolve),
      };
      return chain;
    },
  },
}));

import { useLeasingInquiries } from "@/hooks/useLeasingInquiries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mountInquiries() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: { data?: unknown; fetchStatus: string } = { fetchStatus: "idle" };

  function Harness() {
    latest = useLeasingInquiries();
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

describe("useLeasingInquiries host-company scoping", () => {
  it("filters leasing_inquiries by the host company id", async () => {
    getLandingCompanyId.mockResolvedValue("comp-1");
    const { getLatest } = mountInquiries();

    await vi.waitFor(() => {
      expect(getLatest().data).toEqual({
        items: [{ id: "inq-1", company_id: "comp-1", name: "Sara" }],
        count: 1,
      });
    });

    expect(eqCalls).toContainEqual({
      table: "leasing_inquiries",
      col: "company_id",
      val: "comp-1",
    });
  });

  it("stays disabled and does not query Supabase when no host company exists", async () => {
    getLandingCompanyId.mockResolvedValue(null);
    const { getLatest } = mountInquiries();

    await vi.waitFor(() => {
      expect(getLandingCompanyId).toHaveBeenCalled();
    });

    expect(getLatest().fetchStatus).toBe("idle");
    expect(fromTables).toEqual([]);
  });
});
