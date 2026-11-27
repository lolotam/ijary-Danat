/**
 * @vitest-environment jsdom
 *
 * يثبّت أن بطاقة الاستهلاك تعرض الاستخدام أمام كل حد، وتنبّه عند بلوغ 80%.
 *
 * Only the server-function transport is replaced. React Query, the translation
 * provider and the card's own threshold logic stay real. The new locale module
 * is merged into the dictionaries because `ar.ts` / `en.ts` are another slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { limitsUi as arLimitsUi } from "@/i18n/locales/ar/limitsUi";
import { limitsUi as enLimitsUi } from "@/i18n/locales/en/limitsUi";
import { I18nProvider } from "@/i18n/provider";

const mocks = vi.hoisted(() => ({
  companyUsage: vi.fn(),
}));

vi.mock("@/fns/companyUsage", () => ({
  companyUsage: mocks.companyUsage,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { UsageCard } = await import("./UsageCard");

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/** يركّب البطاقة داخل مزوّد ترجمة عربية ومزوّد React Query حقيقي. */
function mount(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <UsageCard />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

/** ينتظر دورات React حتى تستقر الحالة بعد القراءة. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(dictionaries.ar, arLimitsUi);
  Object.assign(dictionaries.en, enLimitsUi);
  mocks.companyUsage.mockResolvedValue({
    units: { used: 8, limit: 10 },
    staff: { used: 2, limit: 5 },
    whatsapp: { used: 10, limit: 40 },
    storage: { used: 1_610_612_928, limit: 2_147_483_648 },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("the company usage card (T131)", () => {
  it("shows each usage against its limit and warns at 80 percent", async () => {
    mount();
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain(arLimitsUi["limitsUi.usage.title"]);
    expect(text).toContain(arLimitsUi["limitsUi.units"]);
    expect(text).toContain("8 / 10");
    expect(text).toContain("1.5 " + arLimitsUi["limitsUi.usage.gigabytes"]);
    expect(text).toContain(arLimitsUi["limitsUi.usage.notice"]);
  });

  it("shows no warning below 80 percent and prints unlimited in Arabic", async () => {
    mocks.companyUsage.mockResolvedValue({
      units: { used: 1, limit: 10 },
      staff: { used: 0, limit: null },
      whatsapp: { used: 0, limit: 100 },
      storage: { used: 1_048_576, limit: null },
    });
    mount();
    await flush();

    const text = container.textContent ?? "";
    expect(text).not.toContain(arLimitsUi["limitsUi.usage.notice"]);
    expect(text).toContain(arLimitsUi["limitsUi.unlimited"]);
    expect(text).toContain("1 " + arLimitsUi["limitsUi.usage.megabytes"]);
  });

  it("shows the translated read error when the server refuses", async () => {
    mocks.companyUsage.mockRejectedValue(new Error("permission denied"));
    mount();
    await flush();

    expect(container.textContent).toContain(arLimitsUi["limitsUi.usage.loadError"]);
  });
});
