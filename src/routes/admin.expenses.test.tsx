/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك شاشة المصروفات قبل نقل حوارها ومنطق نموذجها إلى ملفات مستقلة.
 *
 * Audit M13 / plan rows 6.12 and 6.13. The expenses route is 930 lines — the
 * page, the add/edit dialog, the schema, the row↔form and form↔payload
 * mappings, and a category manager. Nothing rendered it under test. These
 * cases pin what the split must keep: Edit opens pre-filled, a create derives
 * the NOT NULL `class` column from the recurrence, and a second Save after a
 * create UPDATES the expense just recorded instead of recording another — the
 * dialog stays open after a save, which is exactly how a duplicate would slip
 * in.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  expense: {
    id: "exp-1",
    code: "EXP-0001",
    category_id: null,
    category: null,
    payee: "Water Co",
    amount: 12.5,
    currency: "KWD",
    property_id: null,
    property: null,
    unit_id: null,
    unit: null,
    cost_center: "",
    start_date: null,
    end_date: null,
    recurrence: "monthly",
    expense_date: "2026-09-01",
    status: "approved",
    note: "",
  },
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isAdmin: true, isLoading: false }),
}));
vi.mock("@/hooks/useCardVisibility", () => ({
  useCardVisibility: () => ({ isCardVisible: () => false }),
}));
vi.mock("@/hooks/useCompany", () => ({ useCompany: () => ({ data: { id: "company-1" } }) }));
vi.mock("@/hooks/useProperties", () => ({ useProperties: () => ({ data: { items: [] } }) }));
vi.mock("@/hooks/useUnits", () => ({ useUnits: () => ({ data: { items: [] } }) }));
vi.mock("@/hooks/useExpensesSummary", () => ({ useExpensesSummary: () => ({ data: null }) }));
vi.mock("@/hooks/useExpenses", () => ({
  useExpenses: () => ({
    data: { items: [mocks.expense], count: 1 },
    isLoading: false,
    isError: false,
  }),
  useExpenseExport: () => ({ data: { items: [] } }),
  useExpenseCategories: () => ({ data: [] }),
  useCreateExpense: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateExpense: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteExpense: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateExpenseCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateExpenseCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteExpenseCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/admin/ownedPageKpis", () => ({ ExpensesKpiCards: () => null }));
vi.mock("@/components/admin/SummaryCards", () => ({ SummaryCards: () => null }));
vi.mock("@/components/admin/CsvImportDialog", () => ({ CsvImportDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Route } = await import("@/routes/admin.expenses");
const ExpensesPage = (Route as unknown as { component: () => ReactNode }).component;

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب شاشة المصروفات داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <ExpensesPage />
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

/** يضع قيمة في حقل يديره react-hook-form ويطلق حدث الإدخال. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** حقول الحوار المفتوح. */
function dialogInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[];
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.create.mockReset().mockResolvedValue({ id: "exp-new" });
  mocks.update.mockReset().mockResolvedValue({ id: "exp-new" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("expenses screen", () => {
  it("opens the edit dialog pre-filled from the row", async () => {
    mount();
    await settle();

    await act(async () =>
      (document.querySelector(`[aria-label="${en["common.edit"]}"]`) as HTMLElement).click(),
    );
    await settle();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(en["expenses.edit"]);
    expect(dialogInputs().map((input) => input.value)).toEqual(
      expect.arrayContaining(["Water Co", "12.5", "KWD"]),
    );
  });

  it("a create derives the class from the recurrence, and a second save updates it", async () => {
    mount();
    await settle();

    await act(async () => lastButton(en["expenses.add"]).click());
    await settle();
    const [payee, amount] = dialogInputs();
    typeInto(payee, "Cleaner");
    typeInto(amount, "40");

    await act(async () => lastButton(en["common.save"]).click());
    await settle();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      company_id: "company-1",
      payee: "Cleaner",
      amount: 40,
      currency: "KWD",
      // No recurrence chosen → one-time → sudden_one_time.
      class: "sudden_one_time",
      recurrence: null,
      attachment: null,
    });

    await act(async () => lastButton(en["common.save"]).click());
    await settle();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "exp-new",
        updates: expect.objectContaining({ payee: "Cleaner" }),
      }),
    );
  });
});
