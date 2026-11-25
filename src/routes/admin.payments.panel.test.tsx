/**
 * @vitest-environment jsdom
 *
 * لوحة الدفعات الكاملة: الجدول وحوارات الإنشاء والتوزيع والعكس تتصرف كما كانت.
 *
 * Written before the 924-line `FullPaymentsPanel` was split into its table and
 * dialogs (audit M13, plan row 6.5), and kept afterwards as the proof that the
 * split changed nothing a user can see. Nothing else asserted that the
 * reversal or allocation dialogs still open, or that their confirm buttons
 * still send what the admin typed — which is exactly what a decomposition can
 * quietly break. Hooks are mocked by module path, so the test does not care
 * which file ends up calling them.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY, dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  reverse: vi.fn(),
  allocate: vi.fn(),
  createPayment: vi.fn(),
}));

const PAYMENT = {
  id: "pay-1",
  code: "PAY-000001",
  tenant_id: "tenant-1",
  tenant: { id: "tenant-1", name: "Tenant One", name_ar: null, name_en: "Tenant One" },
  amount: 250,
  currency: "KWD",
  method: "cash",
  payment_date: "2026-09-01",
  created_at: "2026-09-01T10:00:00Z",
  status: "confirmed",
  reference: null,
  reversed_by_payment_id: null,
};

const OPEN_INVOICE = {
  id: "inv-1",
  code: "INV-000001",
  balance: 250,
  period_month: 9,
  period_year: 2026,
  state: "due",
};

const query = <T,>(data: T) => ({ data, isLoading: false, isError: false, isSuccess: true });
const mutation = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, isPending: false });

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: { component: unknown }) => opts,
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useCardVisibility", () => ({
  useCardVisibility: () => ({ isCardVisible: () => true }),
}));
vi.mock("@/hooks/usePaymentsSummary", () => ({ usePaymentsSummary: () => query(null) }));
vi.mock("@/hooks/usePayments", () => ({
  usePayments: () => query({ items: [PAYMENT], count: 1 }),
  useCreateManualPayment: () => mutation(mocks.createPayment),
}));
vi.mock("@/hooks/usePaymentAllocations", () => ({
  usePaymentAllocations: () => query([]),
  useApplyPaymentAllocation: () => mutation(mocks.allocate),
}));
vi.mock("@/hooks/useReversePayment", () => ({ useReversePayment: () => mutation(mocks.reverse) }));
vi.mock("@/hooks/useReceipts", () => ({ useReceipts: () => query([]) }));
vi.mock("@/hooks/useInvoices", () => ({
  useInvoices: () => query({ items: [OPEN_INVOICE], count: 1 }),
}));
vi.mock("@/hooks/useContracts", () => ({
  useContracts: () => query({ items: [], count: 0 }),
  primaryUnit: () => null,
}));
vi.mock("@/hooks/useTenants", () => ({ useTenants: () => query({ items: [], count: 0 }) }));
vi.mock("@/hooks/useCompany", () => ({ useCompany: () => query({ id: "company-1" }) }));
vi.mock("@/hooks/useOptionLists", () => ({
  useListDrivenOptions: () => [{ value: "cash", label: "Cash" }],
}));
vi.mock("@/fns/notifyPaymentSuccess", () => ({ notifyPaymentSuccessFn: vi.fn() }));
vi.mock("@/components/admin/PaymentSidePanels", () => ({
  InsurancePanel: () => null,
  PartialPaymentsPanel: () => null,
  RefundsPanel: () => null,
}));
vi.mock("@/components/admin/PaymentDocumentPrint", () => ({ PaymentDocumentPrint: () => null }));
vi.mock("@/components/admin/PaymentFiltersBar", () => ({ PaymentFiltersBar: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const { Route } = await import("@/routes/admin.payments");
const PaymentsPage = (Route as unknown as { component: ComponentType }).component;
const en = dictionaries.en;

let container: HTMLDivElement;
let root: Root;

/** يركّب صفحة الدفعات بالإنجليزية ويترك المؤثرات تستقر. */
async function mount(): Promise<void> {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <PaymentsPage />
      </I18nProvider>,
    );
  });
}

/** يضغط أول زر يحمل هذا العنوان — أزرار الصفوف أيقونات بلا نص ظاهر. */
async function clickTitled(title: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!button) throw new Error(`no button titled ${title}`);
  await act(async () => button.click());
}

/**
 * يضغط زراً بحسب نصه، مفضّلاً الحوار المفتوح على الصفحة.
 *
 * Row actions carry the same words as the dialog buttons in an `sr-only` span
 * ("Reverse"), so a page-wide search would hit the row button first and the
 * test would assert against a dialog it never confirmed.
 */
async function clickText(text: string): Promise<void> {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
  const scope = dialogs.at(-1) ?? document.body;
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`no button with text ${text}`);
  await act(async () => button.click());
}

/** يكتب قيمة في عنصر إدخال مُتحكَّم به بطريقة يلتقطها React. */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(element);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.reverse.mockReset().mockResolvedValue(undefined);
  mocks.allocate.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("full payments panel", () => {
  it("lists the payment with its code and row actions", async () => {
    await mount();
    expect(container.textContent).toContain(PAYMENT.code);
    expect(document.querySelector(`button[title="${en["payments.allocate"]}"]`)).not.toBeNull();
    expect(document.querySelector(`button[title="${en["payments.reverse"]}"]`)).not.toBeNull();
  });

  it("reverses a payment with the reason the admin typed", async () => {
    await mount();
    await clickTitled(en["payments.reverse"]);

    const reason = document.querySelector<HTMLTextAreaElement>(
      `textarea[placeholder="${en["payments.reverseReason"]}"]`,
    );
    expect(reason).not.toBeNull();
    await typeInto(reason!, "  bounced cheque  ");
    await clickText(en["payments.reverse"]);

    expect(mocks.reverse).toHaveBeenCalledWith({ paymentId: PAYMENT.id, reason: "bounced cheque" });
  });

  it("allocates the ticked invoice's full balance after confirmation", async () => {
    await mount();
    await clickTitled(en["payments.allocate"]);

    const tick = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[role="checkbox"]',
    );
    expect(tick).not.toBeNull();
    await act(async () => tick!.click());
    await clickText(en["payments.applyAllocation"]);
    await clickText(en["common.confirm"]);

    expect(mocks.allocate).toHaveBeenCalledWith({
      paymentId: PAYMENT.id,
      allocations: [{ invoice_id: OPEN_INVOICE.id, amount: OPEN_INVOICE.balance }],
    });
  });

  it("opens the create dialog from the header action", async () => {
    await mount();
    await clickText(en["payments.add"]);
    expect(document.body.textContent).toContain(en["payments.createDescription"]);
  });
});
