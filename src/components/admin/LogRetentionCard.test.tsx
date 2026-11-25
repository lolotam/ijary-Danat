/**
 * @vitest-environment jsdom
 *
 * بطاقة الحذف التلقائي: التفعيل يحذف فوراً فلا يُرسل قبل التأكيد، والإيقاف
 * لا يحذف شيئاً فيُرسل مباشرة.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), company: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/hooks/useCompany", () => ({ useCompany: mocks.company }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { LogRetentionCard } = await import("@/components/admin/LogRetentionCard");

let container: HTMLDivElement;
let root: Root;

/** يرسم البطاقة بإعداد احتفاظ حالي معيّن. */
async function render(auditDays: number | null, canManage = true) {
  mocks.company.mockReturnValue({
    data: { audit_log_retention_days: auditDays, notification_log_retention_days: null },
    isLoading: false,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <I18nProvider>
        <QueryClientProvider client={client}>
          <LogRetentionCard log="audit" canManage={canManage} />
        </QueryClientProvider>
      </I18nProvider>,
    );
  });
}

/** يضغط عنصراً داخل act حتى تكتمل التحديثات الناتجة عنه. */
async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** يجد زر التأكيد في نافذة الحوار (تُرسم خارج الحاوية). */
function confirmButton() {
  const label = dictionaries.ar["common.confirm"];
  return [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: { log: "audit", days: 7, deleted: 3 }, error: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("LogRetentionCard", () => {
  it("enabling asks for confirmation first, then applies the 7-day default", async () => {
    await render(null);

    await click(container.querySelector('[role="switch"]'));
    expect(mocks.rpc).not.toHaveBeenCalled();

    await click(confirmButton());
    expect(mocks.rpc).toHaveBeenCalledWith("set_log_retention", { p_log: "audit", p_days: 7 });
  });

  it("turning it off applies at once, since it deletes nothing", async () => {
    await render(14);

    await click(container.querySelector('[role="switch"]'));
    expect(confirmButton()).toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("set_log_retention", { p_log: "audit", p_days: null });
  });

  it("a user the server would refuse is not offered the switch", async () => {
    await render(null, false);

    expect(container.querySelector('[role="switch"]')?.hasAttribute("disabled")).toBe(true);
  });
});
