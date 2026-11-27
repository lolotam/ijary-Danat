/**
 * @vitest-environment jsdom
 *
 * يثبّت أن حوار التحصيل يترك إيصال الدفعة لحدث المال، لا لنداء صريح.
 *
 * GR-004: `apply_payment_allocation` emits `payment.succeeded` in the same
 * transaction as the allocation (migration 308), and the worker's event
 * handler queues the receipt. The explicit `notifyPaymentSuccessFn` call this
 * dialog used to make was a second request for the same receipts; it is gone,
 * and this test is what keeps it gone — while the settle flow still runs
 * create + allocate per invoice, which is what makes the event fire at all.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lacks the layout observers Radix sizes its popper with.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mocks = vi.hoisted(() => ({
  createPayment: vi.fn(),
  applyAllocation: vi.fn(),
  notifyPaymentSuccessFn: vi.fn(),
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const TENANT_ID = "44444444-4444-4444-8444-444444444444";

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/useContracts", () => ({
  useContracts: () => ({
    data: {
      items: [
        {
          id: CONTRACT_ID,
          code: "CT-1",
          monthly_amount: 250,
          tenant_id: TENANT_ID,
          tenant: { name: "Ahmed", name_en: "Ahmed", preferred_language: "en" },
          units: [{ id: "unit-1", code: "U-1", name: "Flat 12" }],
        },
      ],
    },
  }),
  primaryUnit: (contract: { units?: Array<{ id: string }> }) => contract.units?.[0] ?? null,
}));
vi.mock("@/hooks/useCompany", () => ({
  useCompany: () => ({ data: { id: COMPANY_ID } }),
}));
vi.mock("@/hooks/useInvoices", () => ({
  useInvoices: () => ({
    data: {
      items: [
        {
          id: INVOICE_ID,
          balance: 250,
          code: "INV-1",
          period_month: 8,
          period_year: 2026,
          state: "unpaid",
        },
      ],
    },
    isLoading: false,
    isSuccess: true,
  }),
}));
vi.mock("@/hooks/usePaymentAllocations", () => ({
  useApplyPaymentAllocation: () => ({ mutateAsync: mocks.applyAllocation, isPending: false }),
}));
vi.mock("@/hooks/usePayments", () => ({
  useCreateManualPayment: () => ({ mutateAsync: mocks.createPayment, isPending: false }),
}));
vi.mock("@/fns/notifyPaymentSuccess", () => ({
  notifyPaymentSuccessFn: (...args: unknown[]) => mocks.notifyPaymentSuccessFn(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { CreatePaymentDialog } = await import("@/components/admin/payments/CreatePaymentDialog");

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب الحوار مفتوحاً داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <CreatePaymentDialog
          open
          onOpenChange={() => {}}
          methodOptions={[{ value: "cash", label: "Cash" }]}
        />
      </I18nProvider>,
    );
  });
}

/** ينتظر استقرار التأثيرات بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/**
 * يختار العقد الوحيد من قائمة الاختيار.
 *
 * Radix 2.3.7 opens the trigger and selects an item on a plain `click` when no
 * mouse pointer event preceded it (`pointerTypeRef` stays unset), so the real
 * selection path runs without pointer-capture shenanigans.
 */
async function pickContract(): Promise<void> {
  const trigger = document.querySelector('[role="combobox"]') as HTMLElement;
  act(() => {
    trigger.click();
  });
  await settle();
  const option = [...document.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes("CT-1"),
  );
  if (!option) throw new Error("The contract option did not render.");
  act(() => {
    (option as HTMLElement).click();
  });
  await settle();
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.createPayment.mockReset().mockResolvedValue({ id: "pay-1" });
  mocks.applyAllocation.mockReset().mockResolvedValue({});
  mocks.notifyPaymentSuccessFn.mockReset().mockResolvedValue({ queued: true });
  // jsdom lacks the pointer-capture and layout APIs Radix calls.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("CreatePaymentDialog — the receipt is the event's, not the dialog's (GR-004)", () => {
  it("settles with one create + allocate pair per invoice and calls no notify server fn", async () => {
    mount();
    await settle();
    await pickContract();
    // اختيار العقد يزرع أقدم فاتورة غير مدفوعة تلقائياً.
    await settle();

    const save = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(en["common.save"]),
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
    });
    await settle();

    // الدفعة والخصم هما ما يطلق الحدث — لا نداء إيصال صريح من الحوار.
    expect(mocks.createPayment).toHaveBeenCalledTimes(1);
    expect(mocks.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        notify: false,
        tenantId: TENANT_ID,
        unitId: "unit-1",
        amount: 250,
      }),
    );
    expect(mocks.applyAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.applyAllocation).toHaveBeenCalledWith({
      paymentId: "pay-1",
      allocations: [{ invoice_id: INVOICE_ID, amount: 250 }],
    });
    expect(mocks.notifyPaymentSuccessFn).not.toHaveBeenCalled();
  });
});
