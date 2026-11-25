/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// سجل التدقيق هو نقطة النقل التي يُختبر هنا: عيب H3 كان استدعاءً مزدوجًا
// لنفس الحد (سطر من الـRPC داخل المعاملة وسطر من المتصفح تحت اسم مختلف)،
// والصف الذي يكتبه SQL في الترحيلة 86 هو الوحيد الباقي.
const auditSpy = vi.hoisted(() => vi.fn(async () => ({ id: "audit-1" })));
vi.mock("@/auth/AuthProvider", () => ({ useAuth: () => ({ user: { id: "staff-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) },
  },
}));
vi.mock("@/fns/audit", () => ({ logAudit: auditSpy }));
// Server-function proxies are the browser's transport boundary; the mutation,
// session wrapper, permissions and QueryClient invalidation remain real.
vi.mock("@/fns/closeOutContract", () => ({
  closeOutContract: async () => ({ ok: true, result: {} }),
}));
vi.mock("@/fns/writeOffInvoice", () => ({
  writeOffInvoice: async () => ({ ok: true }),
}));
vi.mock("@/fns/setInvoiceDispute", () => ({
  setInvoiceDispute: async () => ({ ok: true }),
}));
const { useCloseOutContract, useWriteOffInvoice, useSetInvoiceDispute } =
  await import("@/hooks/useContractCloseouts");
let mutations: {
  close: ReturnType<typeof useCloseOutContract>;
  writeOff: ReturnType<typeof useWriteOffInvoice>;
  dispute: ReturnType<typeof useSetInvoiceDispute>;
};
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

/** يلتقط الخطافات الثلاثة تحت الاختبار داخل سياق React Query حقيقي. */
function Probe() {
  mutations = {
    close: useCloseOutContract(),
    writeOff: useWriteOffInvoice(),
    dispute: useSetInvoiceDispute(),
  };
  return null;
}

/** يركّب الخطافات بدور admin مخزّن في الكاش فتتجاوز فحوص الصلاحيات دون اتصال. */
function mount() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["my-roles", "staff-1"], ["admin"]);
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

afterEach(() => {
  auditSpy.mockClear();
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
describe("invoice write-off and dispute audit rows (H3)", () => {
  test("write-off resolves without a second browser audit row", async () => {
    mount();
    let resolved: unknown;
    await act(async () => {
      resolved = await mutations.writeOff.mutateAsync({
        invoiceId: "invoice-1",
        reason: "uncollectable",
        contractId: "contract-1",
      });
    });
    expect(resolved).toMatchObject({ ok: true });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test.each([
    { clear: false, label: "raised" },
    { clear: true, label: "cleared" },
  ])("dispute $label resolves without a second browser audit row", async ({ clear }) => {
    mount();
    await act(async () => {
      await mutations.dispute.mutateAsync({
        invoiceId: "invoice-1",
        reason: "tenant contests a line",
        clear,
        contractId: "contract-1",
      });
    });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("close-out still writes its browser audit row (witness the spy is wired)", async () => {
    mount();
    await act(async () => {
      await mutations.close.mutateAsync(closeoutInput);
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "contract.close_out" }) }),
    );
  });
});
