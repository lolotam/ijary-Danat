/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك شاشة الموظفين قبل نقل تبويبيها إلى ملفات مستقلة.
 *
 * Plan row 6.12. Nothing rendered this screen under test. These cases pin
 * what moving the two tab components must keep: the employees tab lists the
 * rows, and — because the dialog stays open after a save — a second Save
 * updates the employee just created instead of creating a duplicate.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useEmployees", () => ({
  useEmployees: () => ({
    data: {
      items: [{ id: "emp-1", name: "Ahmad", is_active: true, salary: 300 }],
      count: 1,
    },
    isLoading: false,
    isError: false,
  }),
  useCreateEmployee: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateEmployee: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteEmployee: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSalaries: () => ({ data: { items: [], count: 0 }, isLoading: false, isError: false }),
  useGenerateSalaries: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetSalaryDelivered: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Route } = await import("@/routes/admin.employees");
const EmployeesPage = (Route as unknown as { component: () => ReactNode }).component;

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب شاشة الموظفين داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <EmployeesPage />
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

/** آخر زر يحمل النص المطلوب. */
function lastButton(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === text,
  );
  if (!matches.length) throw new Error(`No button "${text}"`);
  return matches[matches.length - 1] as HTMLButtonElement;
}

/** يضع قيمة في حقل تحكمه React ويطلق حدث الإدخال. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.create.mockReset().mockResolvedValue({ id: "emp-new" });
  mocks.update.mockReset().mockResolvedValue({ id: "emp-new" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("employees screen", () => {
  it("lists the employees on the first tab", async () => {
    mount();
    await settle();

    expect(container.textContent).toContain("Ahmad");
  });

  it("a second save after a create updates that employee", async () => {
    mount();
    await settle();

    await act(async () => lastButton(en["employees.add"]).click());
    await settle();
    const nameInput = document.querySelector('[role="dialog"] input') as HTMLInputElement;
    typeInto(nameInput, "Sara");
    await act(async () => lastButton(en["common.save"]).click());
    await settle();
    await act(async () => lastButton(en["common.save"]).click());
    await settle();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ id: "emp-new" });
  });
});
