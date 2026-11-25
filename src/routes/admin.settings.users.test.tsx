/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك شاشة المستخدمين قبل نقل جدولها وحواراتها إلى ملفات مستقلة.
 *
 * Audit M13 / plan row 6.4 moves ~1,000 lines out of this 1,421-line route.
 * Nothing rendered it under test, so these cases pin what a move is most
 * likely to break: the managerial list renders its rows, Edit opens a dialog
 * pre-filled with that user, Create opens the form for the current tab, and
 * Delete asks first and then refuses to report success unless the server
 * confirms `{ deleted: true }` — the guard `deleteAppUser.ts` documents.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  deleteUser: vi.fn(),
  refetch: vi.fn(),
  can: vi.fn(),
  roles: [] as string[],
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  tenantUsers: [] as Array<{
    id: string;
    username: string;
    display_name: string;
    email: string;
    phone: string;
    is_active: boolean;
    tenant_id: string | null;
    roles: string[];
  }>,
  tenantList: [] as Array<{
    id: string;
    name: string;
    name_en: string | null;
    code: string | null;
  }>,
  user: {
    id: "user-1",
    username: "sara",
    display_name: "Sara Accountant",
    email: "sara@example.com",
    phone: "",
    is_active: true,
    tenant_id: null,
    roles: ["accountant"],
  },
}));

vi.mock("@tanstack/react-router", async (original) => {
  const React = await import("react");
  return {
    ...(await original<typeof import("@tanstack/react-router")>()),
    createFileRoute: () => (options: unknown) => options,
    // The tenant column links to the tenant page; there is no router in these
    // tests, so the link renders as a plain anchor. Only the tenants tab with
    // linked rows reaches it — the managerial cases never render one.
    Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
      React.createElement("a", { href: typeof to === "string" ? to : "" }, children),
  };
});
vi.mock("@tanstack/react-start", async (original) => ({
  ...(await original<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/fns/deleteAppUser", () => ({ deleteAppUser: mocks.deleteUser }));
vi.mock("@/fns/createAppUser", () => ({ createAppUser: vi.fn() }));
vi.mock("@/fns/updateAppUser", () => ({ updateAppUser: vi.fn() }));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({
    can: mocks.can,
    canAny: (codes: string[]) => codes.some((code) => mocks.can(code)),
    roles: mocks.roles,
    isAdmin: mocks.roles.includes("admin"),
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/hooks/useTenants", () => ({
  useTenants: () => ({ data: { items: mocks.tenantList } }),
}));
vi.mock("@/hooks/useUserTenants", () => ({
  useUserTenants: () => ({ data: new Map(), refetch: vi.fn() }),
  useSetUserTenants: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useUsers", () => ({
  useUsersWithRoles: () => ({
    data: { items: [mocks.user], count: 1 },
    isLoading: false,
    error: null,
    refetch: mocks.refetch,
  }),
  // The tenants tab loads every tenant-scope user once and filters locally;
  // driven by mocks.tenantUsers so the tenants-tab cases below can seed rows.
  useAllTenantUsers: () => ({
    data: mocks.tenantUsers,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useGrantRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetUserActive: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetUserTenant: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/admin/AssignTenantsDialog", () => ({ AssignTenantsDialog: () => null }));
vi.mock("@/components/admin/TenantMultiSelect", () => ({ TenantMultiSelect: () => null }));
vi.mock("@/components/admin/TenantPicker", () => ({ TenantPicker: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { Route } = await import("@/routes/admin.settings.users");
const UsersPage = (Route as unknown as { component: () => ReactNode }).component;

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب شاشة المستخدمين داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <UsersPage />
      </I18nProvider>,
    ),
  );
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** ينقر أول عنصر يحمل تسمية الوصول المطلوبة. */
async function clickLabel(label: string): Promise<void> {
  const target = document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
  if (!target) throw new Error(`Nothing labelled "${label}"`);
  await act(async () => target.click());
  await settle();
}

/** آخر زر يحمل النص المطلوب — أزرار الحوارات تُرسم بعد الصفحة. */
function lastButton(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes(text),
  );
  if (!matches.length) throw new Error(`No button with text "${text}"`);
  return matches[matches.length - 1] as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.can.mockReset().mockReturnValue(true);
  mocks.roles = ["admin"];
  mocks.deleteUser.mockReset();
  mocks.refetch.mockReset().mockResolvedValue(undefined);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.tenantUsers = [];
  mocks.tenantList = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("users settings screen", () => {
  it("lists the managerial users", async () => {
    mount();
    await settle();

    expect(container.textContent).toContain(mocks.user.display_name);
    expect(container.textContent).toContain(mocks.user.username);
  });

  it("opens the edit dialog pre-filled with that user", async () => {
    mount();
    await settle();

    await clickLabel(en["common.edit"]);

    const values = [...document.querySelectorAll('[role="dialog"] input')].map(
      (input) => (input as HTMLInputElement).value,
    );
    expect(values).toEqual(expect.arrayContaining(["sara", "Sara Accountant", "sara@example.com"]));
  });

  it("opens the create form for the managerial tab", async () => {
    mount();
    await settle();

    await act(async () => lastButton(en["users.addManagerialUser"]).click());
    await settle();

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("deletes only after confirmation, and reports success only on { deleted: true }", async () => {
    mocks.deleteUser.mockResolvedValue({ deleted: true });
    mount();
    await settle();

    await clickLabel(en["common.delete"]);
    expect(mocks.deleteUser).not.toHaveBeenCalled();

    await act(async () => lastButton(en["common.delete"]).click());
    await settle();

    expect(mocks.deleteUser).toHaveBeenCalledWith({ data: { userId: "user-1" } });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(en["users.deleted"]);
  });

  it("does not report a delete the server did not confirm", async () => {
    // A thrown Response resolves client-side; "it did not throw" is not
    // evidence the account is gone.
    mocks.deleteUser.mockResolvedValue(new Response("Forbidden", { status: 403 }));
    mount();
    await settle();

    await clickLabel(en["common.delete"]);
    await act(async () => lastButton(en["common.delete"]).click());
    await settle();

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalled();
  });

  describe("account management is admin-only (audit H5)", () => {
    // The server refuses create/update/delete for anyone without
    // has_role('admin'). A user holding users.create/update/delete but not
    // the admin role used to see three enabled buttons that always failed.

    /** يرجّع زرّ الإجراء بتسمية الوصول المطلوبة. */
    function byLabel(label: string): HTMLButtonElement {
      return document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
    }

    /** مفتاح التفعيل في صف المستخدم. */
    function activeSwitch(): HTMLButtonElement {
      return container.querySelector('[role="switch"]') as HTMLButtonElement;
    }

    it("disables create, edit and delete for a permission holder who is not an admin", async () => {
      mocks.roles = ["accountant"];
      mount();
      await settle();

      expect(lastButton(en["users.addManagerialUser"]).disabled).toBe(true);
      expect(byLabel(en["common.edit"]).disabled).toBe(true);
      expect(byLabel(en["common.delete"]).disabled).toBe(true);
    });

    it("keeps the Active toggle on its own users.update permission", async () => {
      mocks.roles = ["accountant"];
      mount();
      await settle();

      expect(activeSwitch().disabled).toBe(false);
    });

    it("enables create, edit and delete for an admin", async () => {
      mocks.roles = ["admin"];
      mount();
      await settle();

      expect(lastButton(en["users.addManagerialUser"]).disabled).toBe(false);
      expect(byLabel(en["common.edit"]).disabled).toBe(false);
      expect(byLabel(en["common.delete"]).disabled).toBe(false);
    });
  });
});

/**
 * يزرع حسابي بوابة مرتبطين بمستأجرين مختلفين، بأسماء ورموز مميزة.
 *
 * Two portal accounts on two tenants: every filter below must keep exactly
 * one and drop the other, so a filter that matched everything (or nothing)
 * fails rather than passing vacuously.
 */
function seedTenantTab(): void {
  mocks.tenantList = [
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "مستأجر الدانة",
      name_en: "Dana Tower Tenant",
      code: "DANA-101",
    },
    {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      name: "مستأجر آخر",
      name_en: "Other Tenant",
      code: "DANA-102",
    },
  ];
  mocks.tenantUsers = [
    {
      id: "tenant-user-1",
      username: "dana.user",
      display_name: "Dana User",
      email: "dana.user@example.com",
      phone: "",
      is_active: true,
      tenant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      roles: ["tenant"],
    },
    {
      id: "tenant-user-2",
      username: "other.user",
      display_name: "Other User",
      email: "other@example.com",
      phone: "",
      is_active: true,
      tenant_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      roles: ["tenant"],
    },
  ];
}

/** يفتح تبويب المستأجرين بتركيز مشغّله. */
async function openTenantsTab(): Promise<void> {
  // Radix Tabs has no click handler on its triggers: in automatic mode the
  // tab activates on focus, and jsdom's click() never moves focus, so a click
  // here silently stays on the managerial tab.
  const trigger = [...document.querySelectorAll('[role="tab"]')].find((element) =>
    element.textContent?.includes(en["users.tab.tenants"]),
  ) as HTMLElement | undefined;
  if (!trigger) throw new Error("tenants tab trigger not found");
  await act(async () => {
    trigger.focus();
  });
  await settle();
}

/** يكتب في حقل البحث عبر خاصية القيمة الأصلية ليلتقطه React. */
async function typeSearch(value: string): Promise<void> {
  const input = container.querySelector("input") as HTMLInputElement | null;
  if (!input) throw new Error("search input not found");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("value setter not found");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

describe("tenants tab client-side filter", () => {
  it("matches a user by tenant code", async () => {
    seedTenantTab();
    mount();
    await settle();
    await openTenantsTab();
    await typeSearch("DANA-101");

    expect(container.textContent).toContain("Dana User");
    expect(container.textContent).not.toContain("Other User");
  });

  it("matches a user by tenant English name, case-insensitively", async () => {
    seedTenantTab();
    mount();
    await settle();
    await openTenantsTab();
    await typeSearch("dana tower");

    expect(container.textContent).toContain("Dana User");
    expect(container.textContent).not.toContain("Other User");
  });

  it("matches a user by profile email", async () => {
    seedTenantTab();
    mount();
    await settle();
    await openTenantsTab();
    await typeSearch("other@example.com");

    expect(container.textContent).toContain("Other User");
    expect(container.textContent).not.toContain("Dana User");
  });

  it("matches nobody for an unrelated term", async () => {
    seedTenantTab();
    mount();
    await settle();
    await openTenantsTab();
    await typeSearch("zzz-no-such-user");

    expect(container.textContent).not.toContain("Dana User");
    expect(container.textContent).not.toContain("Other User");
    expect(container.textContent).toContain(en["common.empty"]);
  });
});
