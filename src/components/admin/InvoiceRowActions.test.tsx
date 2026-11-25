/**
 * @vitest-environment jsdom
 *
 * INV-0007120 was written off by a close-out, then the tenant-detail action
 * column marked it paid and unpaid again, laundering the write-off away. The
 * toggle must never be offered on a waived or cancelled invoice — the button
 * carries the disabled attribute, never just a class.
 *
 * Same jsdom + createRoot technique as AuthProvider.test.tsx — this repo has
 * no @testing-library, and clicking is not needed to read `disabled`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", dir: "ltr" }),
}));

import { InvoiceRowActions } from "@/components/admin/InvoiceRowActions";

// No @testing-library here: React's act() needs this flag to know it runs in
// a test environment, otherwise every call logs a warning (harmless but noisy).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const handlers = {
  canSend: true,
  canGenerateLink: true,
  canTogglePaid: true,
  onSend: vi.fn(),
  onGenerateLink: vi.fn(),
  onTogglePaid: vi.fn(),
};

/**
 * يبني فاتورة اختبار بالحالة المطلوبة فقط؛ بقية الحقول ثابتة لأن الزر لا يقرأها.
 */
function invoiceIn(state: string) {
  return {
    id: "inv-1",
    code: "INV-1",
    state,
    balance: 100,
    total: 100,
    paid: 0,
    period_year: 2026,
    period_month: 9,
    tenant: null,
    unit: null,
    contract: null,
  } as never;
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

/**
 * يركّب مكوّن إجراءات الفاتورة في جذر React حي.
 */
function mountActions(state: string): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <InvoiceRowActions invoice={invoiceIn(state)} company={null} handlers={handlers} />,
    );
  });
  roots.push({ root, container });
  return container;
}

/**
 * يقرأ زر التبديل عبر aria-label — وهو ما يحلّله getByLabelText هنا.
 */
function toggleButton(container: HTMLDivElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, `the ${label} button should render`).toBeTruthy();
  return button!;
}

afterEach(() => {
  while (roots.length) {
    const { root, container } = roots.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.clearAllMocks();
});

describe("InvoiceRowActions paid toggle", () => {
  test.each(["waived", "cancelled"])("is disabled on a %s invoice", (state) => {
    const container = mountActions(state);
    // The attribute is the real gate: shadcn Button bakes `disabled:*` classes
    // into every render, so matching a class would be vacuously true.
    expect(toggleButton(container, "invoices.markPaid").getAttribute("disabled")).toBe("");
  });

  test.each(["due", "overdue", "partially_paid"])("is enabled on a %s invoice", (state) => {
    const container = mountActions(state);
    expect(toggleButton(container, "invoices.markPaid").getAttribute("disabled")).toBeNull();
  });

  test("is enabled on a paid invoice (unmark leg)", () => {
    const container = mountActions("paid");
    expect(toggleButton(container, "invoices.markUnpaid").getAttribute("disabled")).toBeNull();
  });
});
