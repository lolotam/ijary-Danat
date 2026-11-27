/**
 * @vitest-environment jsdom
 *
 * يثبّت أن لوحة الحدود تحفظ الصفر والبلا حد كما هما، وتحذّر عند التخفيض.
 *
 * Only the browser transport is replaced. The panel's own validation and its
 * draft/saved logic stay real. The locale modules are merged into the real
 * dictionaries because `ar.ts` / `en.ts` are owned by another slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { limitsUi as arLimitsUi } from "@/i18n/locales/ar/limitsUi";
import { limitsUi as enLimitsUi } from "@/i18n/locales/en/limitsUi";
import { I18nProvider } from "@/i18n/provider";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  fetchPlatformLimits: vi.fn(),
  setPlatformLimits: vi.fn(),
}));

vi.mock("@/platform/limitsFns", () => ({
  fetchPlatformLimits: mocks.fetchPlatformLimits,
  setPlatformLimits: mocks.setPlatformLimits,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { LimitsPanel } = await import("./LimitsPanel");

/** حدود شركة محفوظة كما يعيدها الخادم. */
const SAVED = {
  companyId: COMPANY_ID,
  maxUnits: 12,
  maxStaffUsers: 5,
  maxWhatsappPerMonth: null,
  maxStorageBytes: 1_000_000,
};

let container: HTMLDivElement;
let root: Root;

/** يركّب اللوحة داخل مزوّد الترجمة العربي. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <LimitsPanel companyId={COMPANY_ID} />
      </I18nProvider>,
    ),
  );
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** يضع قيمة في حقل تحكمه React ويطلق حدث الإدخال. */
function typeInto(selector: string, value: string): void {
  const input = document.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** يرسل نموذج اللوحة. */
async function submit(): Promise<void> {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(dictionaries.ar, arLimitsUi);
  Object.assign(dictionaries.en, enLimitsUi);
  mocks.fetchPlatformLimits.mockResolvedValue(SAVED);
  mocks.setPlatformLimits.mockResolvedValue(SAVED);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("the company limits panel (T128)", () => {
  it("loads saved ceilings into the form, leaving unlimited fields blank", async () => {
    mount();
    await settle();

    expect(container.textContent).toContain(arLimitsUi["limitsUi.title"]);
    expect((document.querySelector("#platform-limit-maxUnits") as HTMLInputElement).value).toBe(
      "12",
    );
    // A blank input is the panel's representation of an unlimited ceiling.
    expect(
      (document.querySelector("#platform-limit-maxWhatsappPerMonth") as HTMLInputElement).value,
    ).toBe("");
    expect(mocks.setPlatformLimits).not.toHaveBeenCalled();
  });

  it("warns when a ceiling is lowered but still saves it without deleting data", async () => {
    mount();
    await settle();

    typeInto("#platform-limit-maxUnits", "2");
    expect(container.textContent).toContain(arLimitsUi["limitsUi.lowerWarning"]);

    await submit();

    expect(mocks.setPlatformLimits).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      maxUnits: 2,
      maxStaffUsers: 5,
      maxWhatsappPerMonth: null,
      maxStorageBytes: 1_000_000,
    });
    expect(container.textContent).toContain(arLimitsUi["limitsUi.saved"]);
  });

  it.each(["-1", "1.5"])(
    "refuses the invalid ceiling %s before calling the server",
    async (value) => {
      mount();
      await settle();

      typeInto("#platform-limit-maxUnits", value);
      await submit();

      expect(mocks.setPlatformLimits).not.toHaveBeenCalled();
      expect(container.textContent).toContain(arLimitsUi["limitsUi.invalidValue"]);
    },
  );

  it.each([
    ["blank", "", null],
    ["zero", "0", 0],
  ])("sends a %s staff ceiling as %s", async (_label, raw, expected) => {
    mount();
    await settle();

    typeInto("#platform-limit-maxStaffUsers", raw);
    await submit();

    expect(mocks.setPlatformLimits).toHaveBeenCalledWith(
      expect.objectContaining({ maxStaffUsers: expected }),
    );
  });
});
