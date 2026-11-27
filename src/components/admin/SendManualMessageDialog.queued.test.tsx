/**
 * @vitest-environment jsdom
 *
 * يثبت أن الإرسال اليدوي يقول «أُدرجت الرسالة في قائمة الانتظار» لا «تمت».
 *
 * T075: `sendNotification` يكتب صف الإشعار بحالة «في الانتظار» ويسلّمه عامل
 * الإشعارات؛ الطلب نفسه لا يسلّم الرسالة. ف toast «تمت معالجة الرسالة» يقرّ
 * بتسليم لم يقع، والمسؤول يظن أن المستأجر وصله شيء.
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import { deferred as deferredAr } from "@/i18n/locales/ar/deferred";
import { deferred as deferredEn } from "@/i18n/locales/en/deferred";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The catalog spread into `ar`/`en` is the manager's merge step for this
// slice; the test installs the same entries so the assertion holds both before
// and after that merge, and asserts against the shipped wording rather than a
// copy of it.
Object.assign(dictionaries.ar, deferredAr);
Object.assign(dictionaries.en, deferredEn);

const mocks = vi.hoisted(() => {
  // A chainable stand-in for the one Supabase query the dialog runs itself
  // (the renter's contracts). It resolves empty, which is the case that leaves
  // the contract unset.
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };
  return {
    chain,
    sendNotification: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  };
});

vi.mock("@/lib/sendNotification", () => ({
  sendNotificationForCurrentSession: mocks.sendNotification,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => mocks.chain,
    auth: {
      getSession: async () => ({ data: { session: { access_token: "token" } } }),
    },
  },
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));

vi.mock("@/hooks/useTenants", () => ({
  useTenants: () => ({ data: { items: [], count: 0 } }),
  useTenant: () => ({
    data: {
      id: "tenant-1",
      code: "TEN-0007",
      name: "Sara Ali",
      email: "renter@example.com",
      whatsapp: "+96550000000",
      preferred_language: "ar",
      reminders_enabled: true,
    },
  }),
}));

vi.mock("@/hooks/useTenantEligibleTemplates", () => ({
  useTenantEligibleTemplates: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/useMessageVariables", () => ({
  useMessageVariables: () => ({ values: {}, isLoading: false }),
}));

vi.mock("@/components/admin/MessagePreviewPanel", () => ({
  MessagePreviewPanel: ({
    onUnresolvedChange,
  }: {
    onUnresolvedChange?: (variables: string[]) => void;
  }) => {
    // The real panel reports the placeholders it could not resolve; an empty
    // list is what unblocks the Send button.
    useEffect(() => {
      onUnresolvedChange?.([]);
    }, [onUnresolvedChange]);
    return <div data-testid="preview" />;
  },
}));

vi.mock("@/fns/sendCompanyInfo", () => ({ sendCompanyInfo: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

const { SendManualMessageDialog } = await import("@/components/admin/SendManualMessageDialog");

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/** يركّب الحوار داخل مزوّد الترجمة ومزوّد الاستعلامات. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <SendManualMessageDialog open presetTenantId="tenant-1" onOpenChange={() => {}} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

/** ينتظر استقرار التأثيرات بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** زرّ بنصه الظاهر في المستند كله (الحوار يُرسم في بوابة). */
function buttonByText(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!match) throw new Error(`No button with text "${text}"`);
  return match as HTMLButtonElement;
}

/** يكتب في مساحة النص كما تفعل لوحة المفاتيح: React يرى تغيير القيمة. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.sendNotification.mockReset().mockResolvedValue({ id: "notification-1" });
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("the manual-message dialog — sending one renter a message", () => {
  it("reports the message as queued instead of sent", async () => {
    mount();
    await settle();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, "Your rent is due.");
    });
    await settle();

    await act(async () => {
      buttonByText(en["notifications.sendManual"]).click();
    });
    await settle();

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(en["deferred.messageQueued"]);
    // The old wording claimed the renter already had the message.
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(en["notifications.sent"]);
  });
});
