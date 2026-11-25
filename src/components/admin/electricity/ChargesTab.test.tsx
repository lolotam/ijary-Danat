/**
 * @vitest-environment jsdom
 *
 * يثبّت مسار توليد رسوم الكهرباء قبل فصل حواره عن تبويب الرسوم.
 *
 * Audit M30: this tab holds two period selections in one scope — the list
 * filter and the generation period — and only one of them creates money.
 * Before the generate dialog moves into its own component, these cases pin
 * that "Generate" asks for confirmation first, and that the mutation receives
 * the generation period (this month by default) and `unitId: null` for "all".
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/useUnits", () => ({
  useUnits: () => ({ data: { items: [{ id: "unit-1", code: "U-1", name: "Shop" }], count: 1 } }),
}));
vi.mock("@/hooks/useElectricityCharges", () => ({
  useElectricityCharges: () => ({
    data: { items: [], count: 0 },
    isLoading: false,
    isError: false,
  }),
  useUpdateElectricityChargeStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useGenerateElectricityCharges", () => ({
  useGenerateElectricityCharges: () => ({ mutateAsync: mocks.generate, isPending: false }),
}));
vi.mock("@/lib/audit", () => ({ logAuditForCurrentSession: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ChargesTab } = await import("@/components/admin/electricity/ChargesTab");

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب تبويب الرسوم داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <ChargesTab />
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

/** آخر زر في المستند يحمل النص المطلوب (الحوارات تُرسم في بوابة بعد الصفحة). */
function lastButton(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes(text),
  );
  if (!matches.length) throw new Error(`No button with text "${text}"`);
  return matches[matches.length - 1] as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.generate.mockReset().mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("electricity charges tab — generation", () => {
  it("does not generate on the dialog's confirm alone; it asks again first", async () => {
    mount();
    await settle();

    act(() => lastButton(en["electricity.charges.generate"]).click());
    await settle();
    act(() => lastButton(en["common.confirm"]).click());
    await settle();

    expect(mocks.generate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(en["electricity.charges.generateConfirm"]);
  });

  it("generates for the generation period with unitId null for all units", async () => {
    const now = new Date();
    mount();
    await settle();

    act(() => lastButton(en["electricity.charges.generate"]).click());
    await settle();
    act(() => lastButton(en["common.confirm"]).click());
    await settle();
    await act(async () => {
      lastButton(en["common.confirm"]).click();
    });
    await settle();

    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith({
      periodMonth: now.getMonth() + 1,
      periodYear: now.getFullYear(),
      unitId: null,
    });
  });
});
