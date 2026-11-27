/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك لوحة حسابات الشركة: كل إجراء ينادي العملية التي تخصّه.
 *
 * The panel is the only place a super admin touches another company's
 * accounts, so an action that reached the wrong operation — or the wrong
 * account — is the failure this file guards against.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // The translator is one function for the whole file: a new one on every
  // render would give the panel a new `t` each time, and its load effect
  // would then run forever.
  const t = (key: string) => key;
  return {
    t,
    fetchPlatformCompanyUsers: vi.fn(),
    setPlatformCompanyUserActive: vi.fn(),
    createPlatformCompanyUser: vi.fn(),
    resetPlatformCompanyUserPassword: vi.fn(),
  };
});

vi.mock("@/platform/platformFns", async (original) => ({
  ...(await original<typeof import("@/platform/platformFns")>()),
  fetchPlatformCompanyUsers: mocks.fetchPlatformCompanyUsers,
  setPlatformCompanyUserActive: mocks.setPlatformCompanyUserActive,
  createPlatformCompanyUser: mocks.createPlatformCompanyUser,
  resetPlatformCompanyUserPassword: mocks.resetPlatformCompanyUserPassword,
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

const { CompanyUsersPanel } = await import("./CompanyUsersPanel");

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

/** حساب موقوف كما تعرضه اللوحة. */
const USER = {
  id: USER_ID,
  displayName: "Sara",
  username: "sara",
  email: "sara@acme.test",
  phone: null,
  isActive: false,
  mustChangePassword: false,
  roles: ["accountant" as const],
  createdAt: "2026-01-01T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

/** يركّب لوحة حسابات الشركة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CompanyUsersPanel companyId={COMPANY_ID} />));
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** أول زر يحمل النص المطلوب. */
function button(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`No button "${text}"`);
  return match as HTMLButtonElement;
}

describe("the company users panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchPlatformCompanyUsers.mockResolvedValue({ rows: [USER], count: 1 });
    mocks.setPlatformCompanyUserActive.mockResolvedValue({ userId: USER_ID, isActive: true });
    mocks.resetPlatformCompanyUserPassword.mockResolvedValue({
      userId: USER_ID,
      tempPassword: "Tmp-S3cret-Pass",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it("reactivates the account the super admin chose", async () => {
    mount();
    await settle();

    await act(async () => button("platformCompaniesUi.users.activate").click());
    await settle();

    expect(mocks.setPlatformCompanyUserActive).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      userId: USER_ID,
      isActive: true,
    });
  });

  it("resets the password of the account the super admin chose", async () => {
    mount();
    await settle();

    await act(async () => button("platformCompaniesUi.users.resetPassword").click());
    await settle();
    await act(async () => button("common.confirm").click());
    await settle();

    expect(mocks.resetPlatformCompanyUserPassword).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      userId: USER_ID,
    });
    expect(document.body.textContent).toContain("Tmp-S3cret-Pass");
  });
});
