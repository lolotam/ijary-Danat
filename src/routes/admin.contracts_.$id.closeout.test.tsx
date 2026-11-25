/**
 * @vitest-environment jsdom
 *
 * يثبّت مسار معالج إغلاق العقد قبل تقسيم خطواته السبع إلى مكوّنات.
 *
 * Audit M13 / plan row 6.9 — the riskiest decomposition in the plan: one
 * 1,115-line component, one form over the whole schema, a single step index,
 * and five `useEffect`s that seed and reseed that form. Nothing rendered it
 * under test. These cases walk the real wizard and pin what the split must
 * keep: steps advance in order, Back keeps what was entered (one form, not
 * seven), unpaid invoices arrive pre-seeded so step 2 advances, the refund is
 * prefilled from the server preview, submit refuses without the confirmation
 * tick, and a confirmed submit sends the form and shows the success view.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  closeOut: vi.fn(),
  toastError: vi.fn(),
  contract: {
    id: "3f1d2c4e-8a6b-4d5f-9e0a-1b2c3d4e5f60",
    code: "CNT-0042",
    tenant_id: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
    state: "active",
    deposit: 300,
    start_date: "2025-01-01",
    end_date: "2026-12-31",
    updated_at: "2026-09-01T00:00:00Z",
  },
  invoices: [
    {
      id: "7a2b9c1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      code: "INV-0001",
      balance: 100,
      state: "due",
      period_year: 2026,
      period_month: 8,
    },
  ],
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ id: "3f1d2c4e-8a6b-4d5f-9e0a-1b2c3d4e5f60" }),
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/useCompany", () => ({ useCompany: () => ({ data: null }) }));
vi.mock("@/hooks/useContracts", () => ({
  useContract: () => ({ data: mocks.contract, isLoading: false, error: null }),
  useContractUnits: () => ({ data: [] }),
}));
vi.mock("@/hooks/useTenants", () => ({ useTenant: () => ({ data: undefined }) }));
vi.mock("@/hooks/useInvoices", () => ({
  useInvoices: () => ({ data: { items: mocks.invoices, count: 1 }, isLoading: false }),
}));
vi.mock("@/hooks/useContractCloseouts", () => ({
  useCloseOutContract: () => ({ mutateAsync: mocks.closeOut, isPending: false }),
  useCloseoutPreview: () => ({
    data: { refund_total: 180, deposit_held: 300, deductions_total: 20 },
    isLoading: false,
    error: null,
  }),
  useContractCloseout: () => ({ data: null }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { amount: 300 }, error: null }) }),
      }),
    }),
  },
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocks.toastError, warning: vi.fn() },
}));

const { Route } = await import("@/routes/admin.contracts_.$id.closeout");
const CloseoutWizard = (Route as unknown as { component: () => ReactNode }).component;

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب المعالج داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <CloseoutWizard />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** يعثر على زر بنصه الظاهر. */
function button(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!match) throw new Error(`No button "${text}"`);
  return match as HTMLButtonElement;
}

/** عنوان الخطوة الظاهرة حالياً. */
function heading(): string {
  return container.querySelector("h2")?.textContent ?? "";
}

/** ينقر زراً وينتظر استقرار المعالج. */
async function press(text: string): Promise<void> {
  await act(async () => button(text).click());
  await settle();
}

/** يضع قيمة في حقل تحكمه React ويطلق حدث الإدخال. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.closeOut.mockReset().mockResolvedValue({
    result: { closeout_id: "co-1", contract_state: "terminated", refund_total: 180 },
    notificationWarning: false,
  });
  mocks.toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("contract close-out wizard", () => {
  it("opens on the contract step with the contract shown", async () => {
    mount();
    await settle();

    expect(heading()).toBe(en["closeout.step.1"]);
    expect(container.textContent).toContain("CNT-0042");
  });

  it("advances through the invoice step because unpaid invoices arrive seeded", async () => {
    mount();
    await settle();

    await press(en["common.next"]);
    expect(heading()).toBe(en["closeout.step.2"]);
    expect(container.textContent).toContain("INV-0001");

    await press(en["common.next"]);
    expect(heading()).toBe(en["closeout.step.3"]);
  });

  it("keeps the move-out date across Back — one form, not seven", async () => {
    mount();
    await settle();

    typeInto(container.querySelector('input[type="date"]') as HTMLInputElement, "2026-08-15");
    await press(en["common.next"]);
    await press(en["common.back"]);

    expect((container.querySelector('input[type="date"]') as HTMLInputElement).value).toBe(
      "2026-08-15",
    );
  });

  it("prefills the refund from the server preview", async () => {
    mount();
    await settle();

    for (let i = 0; i < 4; i += 1) await press(en["common.next"]);

    expect(heading()).toBe(en["closeout.step.5"]);
    expect((container.querySelector("#refund-amount") as HTMLInputElement).value).toBe("180");
  });

  it("refuses to submit without the confirmation tick", async () => {
    mount();
    await settle();

    for (let i = 0; i < 6; i += 1) await press(en["common.next"]);
    expect(heading()).toBe(en["closeout.step.7"]);

    await press(en["closeout.submit"]);

    expect(mocks.closeOut).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(en["closeout.confirmRequired"]);
  });

  it("a confirmed submit sends the form and shows the success view", async () => {
    mount();
    await settle();

    for (let i = 0; i < 6; i += 1) await press(en["common.next"]);
    await act(async () =>
      (container.querySelector('button[role="checkbox"]') as HTMLElement).click(),
    );
    await settle();
    await press(en["closeout.submit"]);

    expect(mocks.closeOut).toHaveBeenCalledTimes(1);
    expect(mocks.closeOut.mock.calls[0][0]).toMatchObject({
      contractId: "3f1d2c4e-8a6b-4d5f-9e0a-1b2c3d4e5f60",
      refundAmount: 180,
      invoiceActions: [
        {
          invoice_id: "7a2b9c1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
          action: expect.any(String),
          amount: 0,
        },
      ],
      expectedContractUpdatedAt: "2026-09-01T00:00:00Z",
    });
    expect(container.textContent).toContain(en["closeout.successTitle"]);
    expect(container.textContent).toContain("co-1");
  });
});
