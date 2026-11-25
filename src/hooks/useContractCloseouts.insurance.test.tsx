/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const server = vi.hoisted(() => ({ held: 1000, rejectCloseout: false }));
vi.mock("@/auth/AuthProvider", () => ({ useAuth: () => ({ user: { id: "staff-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) },
    rpc: async (name: string) => {
      if (name !== "portal_insurance_total") throw new Error("Unexpected RPC: " + name);
      return { data: server.held, error: null };
    },
  },
}));
// Server-function proxies are the browser's transport boundary; the mutation,
// session wrapper, permissions and QueryClient invalidation remain real.
vi.mock("@/fns/closeOutContract", () => ({
  closeOutContract: async () => {
    if (server.rejectCloseout) throw new Error("close-out rejected");
    server.held = 0;
    return { ok: true, result: {} };
  },
}));
vi.mock("@/fns/voidRefund", () => ({
  voidRefund: async () => {
    server.held = 1000;
    return { ok: true };
  },
}));
vi.mock("@/fns/reverseRefund", () => ({
  reverseRefund: async () => {
    server.held = 1000;
    return { ok: true, rows: [] };
  },
}));
vi.mock("@/fns/reversePayment", () => ({
  reversePayment: async () => {
    server.held = 1000;
    return { ok: true, rows: [] };
  },
}));
vi.mock("@/fns/audit", () => ({ logAudit: async () => ({ id: "audit-1" }) }));
const { useCloseOutContract, useVoidRefund, useReverseRefund } =
  await import("@/hooks/useContractCloseouts");
const { useReversePayment } = await import("@/hooks/useReversePayment");
const { usePortalInsurancePaid } = await import("@/hooks/usePortalData");
let mutations: {
  close: ReturnType<typeof useCloseOutContract>;
  void: ReturnType<typeof useVoidRefund>;
  reverse: ReturnType<typeof useReverseRefund>;
  reverseSettlement: ReturnType<typeof useReversePayment>;
};
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

/** يركّب خطاف الرصيد الحقيقي حتى يظهر أثر إبطال الكاش في البطاقة. */
function Probe() {
  mutations = {
    close: useCloseOutContract(),
    void: useVoidRefund(),
    reverse: useReverseRefund(),
    reverseSettlement: useReversePayment(),
  };
  const insurance = usePortalInsurancePaid("tenant-1", "contract-1");
  return <output>{insurance.data}</output>;
}

/** يُبقي الرصيد المحفوظ حديثًا؛ لن يتغير إلا إذا أبطلته العملية المالية. */
function mount(held: number) {
  server.held = held;
  server.rejectCloseout = false;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["my-roles", "staff-1"], ["admin"]);
  queryClient.setQueryData(["insurance_payments", "portal-total", "tenant-1", "contract-1"], held);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
}

/** ينتظر ظهور الرصيد الجديد دون الاعتماد على توقيت إشعارات React Query. */
async function expectHeld(amount: number) {
  const deadline = Date.now() + 1500;
  while (container.textContent !== String(amount) && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(container.textContent).toBe(String(amount));
}
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});
const closeoutInput = {
  contractId: "contract-1",
  moveOutDate: "2026-09-17",
  outcome: "keep_terminated" as const,
  finalContractState: "terminated" as const,
  archiveTenant: false,
  deductions: [],
  invoiceActions: [],
  refundAmount: 1000,
  note: null,
  idempotencyKey: "request-1",
};
describe("portal held insurance after close-out money mutations", () => {
  test("completed close-out refreshes a previously fresh portal preview", async () => {
    mount(1000);
    await act(async () => {
      await mutations.close.mutateAsync(closeoutInput);
    });
    await expectHeld(0);
  });
  test.each(["void", "reverse"] as const)(
    "%s refund refreshes returned insurance",
    async (action) => {
      mount(0);
      await act(async () => {
        await mutations[action].mutateAsync({
          refundId: "refund-1",
          contractId: "contract-1",
          reason: "returned",
        });
      });
      await expectHeld(1000);
    },
  );
  test("reversing a settlement refreshes retained insurance", async () => {
    mount(750);
    await act(async () => {
      await mutations.reverseSettlement.mutateAsync({ paymentId: "payment-1", reason: "returned" });
    });
    await expectHeld(1000);
  });
  test("a rejected close-out keeps the previously held amount", async () => {
    mount(1000);
    server.rejectCloseout = true;
    await act(async () => {
      await expect(mutations.close.mutateAsync(closeoutInput)).rejects.toThrow(
        "close-out rejected",
      );
    });
    await expectHeld(1000);
  });
});
