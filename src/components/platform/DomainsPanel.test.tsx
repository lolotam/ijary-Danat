/**
 * @vitest-environment jsdom
 *
 * يثبت أن لوحة النطاقات تسرد النطاقات، وتضيف نطاقاً جديداً، وتتحقق من حالتها.
 *
 * Only the browser transport is replaced; the panel's own behaviour — refusing
 * an empty host, showing the provider's answer — stays real. The locale
 * modules are merged into the real dictionaries because `ar.ts` / `en.ts` are
 * owned by another slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { platformDomains as arPlatformDomains } from "@/i18n/locales/ar/platformDomains";
import { platformDomains as enPlatformDomains } from "@/i18n/locales/en/platformDomains";
import { I18nProvider } from "@/i18n/provider";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  fetchPlatformCompanyDomains: vi.fn(),
  addPlatformCustomDomain: vi.fn(),
  verifyPlatformCustomDomain: vi.fn(),
}));

vi.mock("@/platform/domainsFns", () => ({
  fetchPlatformCompanyDomains: mocks.fetchPlatformCompanyDomains,
  addPlatformCustomDomain: mocks.addPlatformCustomDomain,
  verifyPlatformCustomDomain: mocks.verifyPlatformCustomDomain,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DomainsPanel } = await import("./DomainsPanel");

/** نطاق مخصّص كما يعيده الخادم. */
function domain(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    companyId: COMPANY_ID,
    host: "www.acme.com",
    kind: "custom",
    isPrimary: false,
    verificationStatus: "pending",
    providerRef: "cf-hostname-1",
    verificationRecords: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

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
        <DomainsPanel companyId={COMPANY_ID} />
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

/** يضغط الزرّ الذي يحمل النصّ المطلوب. */
function clickButton(label: string): void {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  act(() => {
    button!.click();
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
  Object.assign(dictionaries.ar, arPlatformDomains);
  Object.assign(dictionaries.en, enPlatformDomains);
  mocks.fetchPlatformCompanyDomains.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("the company domains panel (T193)", () => {
  it("lists the domains of the company with the state of each one", async () => {
    mocks.fetchPlatformCompanyDomains.mockResolvedValue([
      domain({ id: "1", host: "acme.ijary.app", kind: "subdomain" }),
      domain({ id: "2", host: "www.acme.com", verificationStatus: "verified" }),
    ]);

    mount();
    await settle();

    expect(container.textContent).toContain("acme.ijary.app");
    expect(container.textContent).toContain("www.acme.com");
    expect(container.textContent).toContain(arPlatformDomains["platformDomains.status.verified"]);
  });

  it("adds a typed domain and shows it in the list", async () => {
    mocks.addPlatformCustomDomain.mockResolvedValue(domain({ host: "shop.acme.com" }));

    mount();
    await settle();

    typeInto("#platform-domain-host", "shop.acme.com");
    await submit();

    expect(mocks.addPlatformCustomDomain).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      host: "shop.acme.com",
    });
    expect(container.textContent).toContain("shop.acme.com");
  });

  it("refuses an empty host without calling the server", async () => {
    mount();
    await settle();

    await submit();

    expect(mocks.addPlatformCustomDomain).not.toHaveBeenCalled();
    expect(container.textContent).toContain(arPlatformDomains["platformDomains.error.invalid"]);
  });

  it("reads the provider's answer when a domain is verified", async () => {
    mocks.fetchPlatformCompanyDomains.mockResolvedValue([domain()]);
    mocks.verifyPlatformCustomDomain.mockResolvedValue(domain({ verificationStatus: "verified" }));

    mount();
    await settle();

    clickButton(arPlatformDomains["platformDomains.verify"]);
    await settle();

    expect(mocks.verifyPlatformCustomDomain).toHaveBeenCalledWith({
      domainId: "44444444-4444-4444-8444-444444444444",
    });
    expect(container.textContent).toContain(arPlatformDomains["platformDomains.status.verified"]);
  });

  it("shows the translated reason when the server refuses the host", async () => {
    mocks.addPlatformCustomDomain.mockRejectedValue(new Error("DOMAIN_TAKEN"));

    mount();
    await settle();

    typeInto("#platform-domain-host", "www.acme.com");
    await submit();

    expect(container.textContent).toContain(arPlatformDomains["platformDomains.error.taken"]);
  });
});
