/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك نافذة إنشاء الشركة: كلمة المرور المؤقتة تُعرض مرة واحدة.
 *
 * The password is the only thing the super admin cannot get back, so the
 * screen has to show it after the company exists and forget it the moment the
 * dialog closes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => {
  // The translator is one function for the whole file: a new one on every
  // render would give the dialog a new `t` each time.
  const t = (key: string) => key;
  return { t, createPlatformCompany: vi.fn() };
});

vi.mock("@/platform/platformFns", async (original) => ({
  ...(await original<typeof import("@/platform/platformFns")>()),
  createPlatformCompany: mocks.createPlatformCompany,
}));

// The provider is replaced so the rendered text is the translation key itself:
// the catalogue this slice ships is registered by the manager, and a test that
// depended on that registration would break the moment it lands.
vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({
    t: mocks.t,
    locale: "ar",
    dir: "rtl",
    setLocale: vi.fn(),
    toggle: vi.fn(),
  }),
  useOptionalI18n: () => ({
    t: mocks.t,
    locale: "ar",
    dir: "rtl",
    setLocale: vi.fn(),
    toggle: vi.fn(),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CompanyCreateDialog } = await import("./CompanyCreateDialog");

const TEMP_PASSWORD = "Tmp-S3cret-Pass";

let container: HTMLDivElement;
let root: Root;
let onOpenChange: Mock<(open: boolean) => void>;

/** يركّب نافذة إنشاء الشركة بحالة مفتوحة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <CompanyCreateDialog open onOpenChange={onOpenChange} onCompanyCreated={vi.fn()} />,
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

/** آخر زر يحمل النص المطلوب. */
function button(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll("button")].filter(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!matches.length) throw new Error(`No button "${text}"`);
  return matches[matches.length - 1] as HTMLButtonElement;
}

/** يملأ نموذج الإنشاء باسم شركة ومدير أول. */
function fillForm(): void {
  typeInto("#platform-company-name-ar", "أكمي");
  typeInto("#platform-company-name-en", "Acme");
  typeInto("#platform-company-slug", "acme");
  typeInto("#platform-company-admin-name", "Amina");
}

describe("the company create dialog", () => {
  beforeEach(() => {
    onOpenChange = vi.fn<(open: boolean) => void>();
    mocks.createPlatformCompany.mockReset().mockResolvedValue({
      companyId: "22222222-2222-4222-8222-222222222222",
      host: "acme.ijary.app",
      tempPassword: TEMP_PASSWORD,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it("shows the temporary password once and forgets it when the dialog closes", async () => {
    mount();
    await settle();

    fillForm();
    await act(async () => button("platformCompaniesUi.create.submit").click());
    await settle();

    expect(mocks.createPlatformCompany).toHaveBeenCalledWith({
      nameAr: "أكمي",
      nameEn: "Acme",
      slug: "acme",
      firstAdmin: {
        fullName: "Amina",
        username: null,
        email: null,
        phone: null,
      },
    });
    expect(document.body.textContent).toContain(TEMP_PASSWORD);

    await act(async () => button("platformCompaniesUi.create.done").click());
    await settle();

    act(() =>
      root.render(
        <CompanyCreateDialog open onOpenChange={onOpenChange} onCompanyCreated={vi.fn()} />,
      ),
    );
    await settle();

    expect(document.body.textContent).not.toContain(TEMP_PASSWORD);
    expect((document.querySelector("#platform-company-name-ar") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("refuses a short name that the database would refuse", async () => {
    mount();
    await settle();

    typeInto("#platform-company-name-ar", "أكمي");
    typeInto("#platform-company-name-en", "Acme");
    typeInto("#platform-company-slug", "Acme");
    typeInto("#platform-company-admin-name", "Amina");

    await act(async () => button("platformCompaniesUi.create.submit").click());
    await settle();

    expect(mocks.createPlatformCompany).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("platformCompaniesUi.create.slugInvalid");
  });
});
