/**
 * @vitest-environment jsdom
 *
 * يثبت أن إرسال رابط كي نت يقول «أُدرجت الرسالة في قائمة الانتظار» لا «أُرسلت».
 *
 * T075: `sendNotification` يكتب صف الإشعار ثم يسلّمه عامل الإشعارات؛ هو لا
 * يسلّم الرسالة. ف toast يقول «تم إرسال رابط الدفع» يدّعي تسليمة لم يحدثت
 * عند أي مزوّد.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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

const mocks = vi.hoisted(() => ({
  onClose: vi.fn(),
  sendNotification: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/fns/sendNotification", () => ({
  sendNotification: mocks.sendNotification,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "token" } } }),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

const { KnetLinkDialog } = await import("@/components/admin/invoices/KnetLinkDialog");

const LINK = {
  code: "INV-0001",
  url: "https://pay.example.com/inv-0001",
  tenantId: "tenant-1",
  tenantEmail: "renter@example.com",
  tenantWhatsapp: "+96550000000",
};

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب الحوار داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <KnetLinkDialog link={LINK} onClose={mocks.onClose} />
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

/** زرّ بنصه الظاهر في المستند كله (الحوار يُرسم في بوابة). */
function buttonByText(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!match) throw new Error(`No button with text "${text}"`);
  return match as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.sendNotification.mockReset().mockResolvedValue({ id: "notification-1" });
  mocks.onClose.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("the KNET link dialog — sending the link to the renter", () => {
  it("reports the message as queued instead of sent", async () => {
    mount();
    await settle();

    await act(async () => {
      buttonByText(en["invoices.knetSend"]).click();
    });
    await settle();

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(en["deferred.messageQueued"]);
    // The old wording claimed the renter already had the link.
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(en["invoices.knetSendDone"]);
  });
});
