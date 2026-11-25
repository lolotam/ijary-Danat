/**
 * @vitest-environment jsdom
 *
 * يثبّت إجراءات صف الفاتورة في الجدولين قبل نقل حالتها إلى مكان مشترك.
 *
 * Audit M29: `InvoicesTable` (the monthly screen) and `InvoiceRowsTable` (the
 * tenant screen) each carry their own copy of the mark-paid and send state and
 * handlers — copies whose comments already say they must behave identically
 * ("so a failed row cannot toast success here while the other screen still
 * does"). Before that state moves, these cases pin, for BOTH tables: marking
 * paid goes through the method dialog and sends the chosen method; un-marking
 * is direct with no method; sending uses the channels the dialog offers.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  togglePaid: vi.fn(),
  send: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@tanstack/react-start", async (original) => ({
  ...(await original<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/fns/setInvoicePaid", () => ({ setInvoicePaid: mocks.togglePaid }));
vi.mock("@/fns/sendInvoiceToTenant", () => ({ sendInvoiceToTenant: mocks.send }));
vi.mock("@/fns/createPayment", () => ({ createPayment: vi.fn() }));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/useCompany", () => ({ useCompany: () => ({ data: null }) }));
vi.mock("@/hooks/useInvoiceDiscounts", () => ({
  useInvoiceDiscounts: () => ({ data: new Map() }),
}));
vi.mock("@/hooks/useInvoices", () => ({
  useInvoiceDetails: () => ({ data: null }),
  useUpdateInvoiceVisibility: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/admin/EntityLink", () => ({
  EntityLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/admin/LocationCells", () => ({
  UnitsCell: () => null,
  PropertiesCell: () => null,
}));
vi.mock("@/components/admin/InvoiceDiscountCell", () => ({ InvoiceDiscountCell: () => null }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The method dialog is Radix Select inside a portal; its own contract is pinned
// by MarkInvoicePaidDialog.test.tsx. Here only "opens, then confirms a method".
vi.mock("@/components/admin/MarkInvoicePaidDialog", () => ({
  MarkInvoicePaidDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: (m: string) => void;
  }) =>
    open ? (
      <button type="button" data-testid="confirm-method" onClick={() => onConfirm("cash")}>
        confirm
      </button>
    ) : null,
}));
// The monthly table hands its send dialog to InvoiceDialogs; expose its send.
vi.mock("@/components/admin/invoices/InvoiceDialogs", () => ({
  copyToClipboard: vi.fn(),
  InvoiceDialogs: ({ sendInvoice, onSend }: { sendInvoice: unknown; onSend: () => void }) =>
    sendInvoice ? (
      <button type="button" data-testid="monthly-send" onClick={onSend}>
        send
      </button>
    ) : null,
}));

const { InvoicesTable } = await import("@/components/admin/invoices/InvoicesTable");
const { InvoiceRowsTable } = await import("@/components/admin/tenant-detail/InvoiceRowsTable");

const en = dictionaries.en;

/** فاتورة مستحقة لمستأجر لديه بريد وليس لديه واتساب. */
function invoice(state: string) {
  return {
    id: `inv-${state}`,
    code: `INV-${state}`,
    state,
    total: 100,
    paid: state === "paid" ? 100 : 0,
    balance: state === "paid" ? 0 : 100,
    discount: 0,
    due_date: "2026-09-01",
    period_month: 9,
    period_year: 2026,
    is_visible_to_tenant: true,
    payment_method: null,
    disputed_at: null,
    tenant_id: "tenant-1",
    tenant: {
      id: "tenant-1",
      name: "Tenant",
      email: "t@example.com",
      whatsapp: null,
      mobile: null,
    },
    contract: { code: "C-1", archived_at: null },
    units: [],
    properties: [],
  } as never;
}

const tables = [
  {
    name: "monthly InvoicesTable",
    render: (rows: never[]) => (
      <InvoicesTable
        invoices={rows}
        page={1}
        pageSize={10}
        canUpdate
        canCreatePayment
        isMobile={false}
      />
    ),
    sendTrigger: () => document.querySelector('[data-testid="monthly-send"]') as HTMLElement,
  },
  {
    name: "tenant InvoiceRowsTable",
    render: (rows: never[]) => <InvoiceRowsTable invoices={rows} loading={false} error={false} />,
    sendTrigger: () =>
      [...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent === en["invoices.send"],
      ) as HTMLElement,
  },
];

let container: HTMLDivElement;
let root: Root;

/** يركّب الجدول داخل مزوّد الترجمة. */
function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<I18nProvider>{node}</I18nProvider>));
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** ينقر أول عنصر يحمل تسمية الوصول المطلوبة. */
async function clickLabel(label: string): Promise<void> {
  const target = document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
  if (!target) throw new Error(`Nothing labelled "${label}"`);
  await act(async () => target.click());
  await settle();
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.togglePaid.mockReset().mockResolvedValue({ updated: true });
  mocks.send
    .mockReset()
    .mockResolvedValue({ sent: ["email"], queued: [], failed: [], refused: [] });
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe.each(tables)("$name row actions", ({ render, sendTrigger }) => {
  it("marking paid opens the method dialog and sends the chosen method", async () => {
    mount(render([invoice("due")]));
    await settle();

    await clickLabel(en["invoices.markPaid"]);
    expect(mocks.togglePaid).not.toHaveBeenCalled();

    await act(async () =>
      (document.querySelector('[data-testid="confirm-method"]') as HTMLElement).click(),
    );
    await settle();

    expect(mocks.togglePaid).toHaveBeenCalledWith({
      data: { invoiceId: "inv-due", paymentMethod: "cash", paid: true },
    });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["invoices"] });
    expect(document.querySelector('[data-testid="confirm-method"]')).toBeNull();
  });

  it("un-marking is direct and carries no method", async () => {
    mount(render([invoice("paid")]));
    await settle();

    await clickLabel(en["invoices.markUnpaid"]);

    expect(document.querySelector('[data-testid="confirm-method"]')).toBeNull();
    expect(mocks.togglePaid).toHaveBeenCalledWith({
      data: { invoiceId: "inv-paid", paymentMethod: null, paid: false },
    });
  });

  it("sending a paid invoice defaults to email when the tenant has one", async () => {
    // Both tables offer "send" only on a paid invoice (a receipt, not a bill).
    mount(render([invoice("paid")]));
    await settle();

    await clickLabel(en["invoices.sendInvoice"]);
    await act(async () => sendTrigger().click());
    await settle();

    expect(mocks.send).toHaveBeenCalledWith({
      data: { invoiceId: "inv-paid", channels: ["email"] },
    });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["notifications"] });
  });
});
