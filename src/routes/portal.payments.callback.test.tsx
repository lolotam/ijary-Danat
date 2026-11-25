/**
 * @vitest-environment jsdom
 *
 * Drives PaymentCallbackPage with a confirmPayment mutation that "resolves"
 * with a non-union status — the value TanStack Start hands the client when a
 * server fn throws a `Response` (marked `x-tss-raw`, resolved not rejected).
 * The page must fall back to the error branch instead of rendering nothing
 * while the tenant's card was already charged (audit finding H1).
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** نتيجة التأكيد الوهمية: الرقم مقصود ليحاكي رمي `Response` من الخادم. */
type ConfirmOutcome = { status: string | number };

const confirmOutcome = vi.hoisted(() => ({ result: { status: "paid" } as ConfirmOutcome }));

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));

vi.mock("@/hooks/usePortalData", () => ({
  usePortalIdentity: () => ({ data: undefined }),
}));

vi.mock("@/hooks/useConfirmPayment", () => ({
  useConfirmPayment: () => ({
    mutate: (_input: unknown, options: { onSuccess: (result: ConfirmOutcome) => void }) => {
      options.onSuccess(confirmOutcome.result);
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: { component: unknown }) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const { PaymentCallbackPage } = await import("@/routes/portal_.payments.callback");

let container: HTMLDivElement;
let root: Root;

/** يركّب صفحة استلام الدفع داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <PaymentCallbackPage search={{ paymentId: "MF-PAY-1" }} />
      </I18nProvider>,
    );
  });
}

/**
 * يهدهد العرض حتى تستقر تأثيرات الجلسة والترجمة ووعد التأكيد.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("payments callback state guard", () => {
  it("renders the unknown-outcome fallback when the mutation resolves with a numeric status (x-tss-raw Response shape)", async () => {
    confirmOutcome.result = { status: 500 };
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mount();
    await settle();
    expect(container.textContent).toContain(dictionaries.en["portal.callback.unknown"]);
  });

  it("renders the paid confirmation for a real union status", async () => {
    confirmOutcome.result = { status: "paid" };
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mount();
    await settle();
    expect(container.textContent).toContain(dictionaries.en["portal.callback.paid"]);
  });
});
