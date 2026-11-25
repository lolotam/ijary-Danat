/**
 * @vitest-environment jsdom
 *
 * حفظ تعديل عنصر القائمة على طورين: إعادة تسمية القيمة عبر الـ RPC أولاً
 * (بعد معاينة واعتماد)، ثم تحديث الأسماء دون value.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import type { OptionList, OptionListItem } from "@/hooks/useOptionLists";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = dictionaries.ar;

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  rename: vi.fn(),
  update: vi.fn(),
  refetch: vi.fn(),
  items: [] as OptionListItem[],
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/useOptionLists", () => ({
  useOptionListItems: () => ({
    data: mocks.items,
    isLoading: false,
    error: null,
    refetch: mocks.refetch,
  }),
  useCreateOptionListItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateOptionListItem: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteOptionListItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useOptionListValueUsage: () => ({ mutateAsync: mocks.usage, isPending: false }),
  useRenameOptionListValue: () => ({ mutateAsync: mocks.rename, isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
  },
}));

const { ListItemsPanel } = await import("@/components/admin/settings/ListItemsPanel");

const LIST = {
  id: "list-unit-types",
  code: "unit_types",
  name_ar: "أنواع الوحدات",
  name_en: "Unit types",
} as OptionList;

/** عنصر قائمة واحد بالحالة المعطاة لصف واحد يسهل الاستعلام عنه. */
function itemRow(overrides: Partial<OptionListItem> = {}): OptionListItem {
  return {
    id: "item-1",
    list_id: LIST.id,
    value: "old-value",
    label_ar: "قيمة قديمة",
    label_en: "Old value",
    sort_order: 0,
    is_active: true,
    is_system: false,
    ...overrides,
  } as OptionListItem;
}

let container: HTMLDivElement;
let root: Root;

/** يركّب اللوحة بعنصر واحد داخل مزوّد الترجمة العربية. */
function mountPanel(list: OptionList = LIST): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <ListItemsPanel list={list} />
      </I18nProvider>,
    );
  });
}

/** ينتظر دورات React حتى تستقر الحالة بعد حدث غير متزامن. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** ينقر زراً داخل الحاوية المركّبة. */
function clickInPanel(selector: string): void {
  const button = container.querySelector(selector);
  if (!button) throw new Error(`button not found: ${selector}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** ينقر زراً داخل حوار التنبيه (يُركَّب في portal خارج الحاوية). */
function clickInDialog(text: string): void {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`dialog button not found: ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** يجد زراً في الصف المحرَّر بتسميته المترجمة. */
function editingButton(labelKey: string): Element {
  const selector = `button[aria-label="${t[labelKey]}"]`;
  const button = container.querySelector(selector);
  if (!button) throw new Error(`editing button not found: ${selector}`);
  return button;
}

/** مدخلات الصف المحرَّر: القيمة ثم الاسم العربي ثم الإنجليزي ثم الترتيب. */
function editingInputs(): HTMLInputElement[] {
  const row = editingButton("common.save").closest("tr");
  if (!row) throw new Error("editing row not found");
  return [...row.querySelectorAll("input")] as HTMLInputElement[];
}

/** يكتب في مدخل متحكَّم فيه كما يفعل المتصفح الحقيقي. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** يفتح التحرير ويغيّر القيمة المخزّنة إلى الجديدة. */
function startEditWithNewValue(newValue: string): void {
  clickInPanel(`button[aria-label="${t["common.edit"]}"]`);
  setInputValue(editingInputs()[0], newValue);
}

/** يفتح التحرير ويغيّر الاسم العربي فقط (القيمة تبقى كما هي). */
function startEditWithNewLabel(): void {
  clickInPanel(`button[aria-label="${t["common.edit"]}"]`);
  setInputValue(editingInputs()[1], "اسم جديد");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.items = [itemRow()];
  mocks.refetch.mockResolvedValue({ data: mocks.items });
  mocks.usage.mockResolvedValue({ "units.type": 2 });
  mocks.rename.mockResolvedValue({ updated: { "units.type": 2 } });
  mocks.update.mockResolvedValue({ id: "item-1" });
  mountPanel();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ListItemsPanel rename flow", () => {
  it("changing the value shows the counts dialog, then renames and updates without value", async () => {
    startEditWithNewValue("new-value");
    clickInPanel(`button[aria-label="${t["common.save"]}"]`);
    await flush();

    // Preview first: the RPC count decides what the dialog lists.
    expect(mocks.usage).toHaveBeenCalledWith("item-1");
    expect(document.body.textContent).toContain("old-value");
    expect(document.body.textContent).toContain("new-value");
    expect(document.body.textContent).toContain("2");
    expect(mocks.rename).not.toHaveBeenCalled();

    clickInDialog(t["common.confirm"]);
    await flush();

    expect(mocks.rename).toHaveBeenCalledWith({ itemId: "item-1", newValue: "new-value" });
    // The metadata update must not carry `value`: the database trigger rejects
    // direct value writes outside the rename function.
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const updates = mocks.update.mock.calls[0]?.[0].updates as Record<string, unknown>;
    expect(updates).not.toHaveProperty("value");
    expect(updates.label_ar).toBe("قيمة قديمة");
    // Full success closes the row: no save button left.
    expect(container.querySelector(`button[aria-label="${t["common.save"]}"]`)).toBeNull();
  });

  it("cancelling the dialog saves nothing and keeps the row open", async () => {
    startEditWithNewValue("new-value");
    clickInPanel(`button[aria-label="${t["common.save"]}"]`);
    await flush();
    expect(mocks.usage).toHaveBeenCalledTimes(1);

    clickInDialog(t["common.cancel"]);
    await flush();

    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.querySelector(`button[aria-label="${t["common.save"]}"]`)).not.toBeNull();
  });

  it("a duplicate value keeps the row open and saves nothing", async () => {
    mocks.rename.mockRejectedValue(Object.assign(new Error("exists"), { code: "23505" }));
    startEditWithNewValue("taken-value");
    clickInPanel(`button[aria-label="${t["common.save"]}"]`);
    await flush();
    clickInDialog(t["common.confirm"]);
    await flush();

    expect(mocks.toastError).toHaveBeenCalledWith(t["lists.renameValueDuplicate"]);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.querySelector(`button[aria-label="${t["common.save"]}"]`)).not.toBeNull();
  });

  it("rename-ok plus metadata failure keeps the row open, and a retry updates metadata only", async () => {
    mocks.update.mockRejectedValueOnce(new Error("audit failed"));
    startEditWithNewValue("new-value");
    clickInPanel(`button[aria-label="${t["common.save"]}"]`);
    await flush();
    clickInDialog(t["common.confirm"]);
    await flush();

    // The rename committed, so the retry must not run it twice.
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(t["lists.renameValueLabelsNotSaved"]);
    expect(container.querySelector(`button[aria-label="${t["common.save"]}"]`)).not.toBeNull();

    mocks.update.mockResolvedValue({ id: "item-1" });
    clickInPanel(`button[aria-label="${t["common.save"]}"]`);
    await flush();

    expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(container.querySelector(`button[aria-label="${t["common.save"]}"]`)).toBeNull();
  });

  it("an unchanged value skips both rename RPCs and updates metadata only", async () => {
    startEditWithNewLabel();
    clickInPanel(`button[aria-label="${t["common.save"]}"]`);
    await flush();

    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const updates = mocks.update.mock.calls[0]?.[0].updates as Record<string, unknown>;
    expect(updates.label_ar).toBe("اسم جديد");
  });

  it("a refused rename (22023) shows the translated message and saves nothing", async () => {
    mocks.rename.mockRejectedValue(Object.assign(new Error("refused"), { code: "22023" }));
    startEditWithNewValue("new-value");
    clickInPanel(`button[aria-label="${t["common.save"]}"]`);
    await flush();
    clickInDialog(t["common.confirm"]);
    await flush();

    // The raw Postgres message is English; the admin must see the Arabic reason.
    expect(mocks.toastError).toHaveBeenCalledWith(t["lists.renameValueRefused"]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["tenant_categories", "manual_payment_reasons", "unit_statuses"])(
    "a %s value is read-only because the server refuses its renames",
    (code) => {
      act(() => {
        root.unmount();
      });
      container.remove();
      mountPanel({ ...LIST, code } as OptionList);

      clickInPanel(`button[aria-label="${t["common.edit"]}"]`);
      const valueInput = editingInputs()[0];
      expect(valueInput.disabled).toBe(true);
      expect(valueInput.title).toBe(t["lists.valueRenameRefusedList"]);
    },
  );

  it("a code-bound value input is disabled with an explaining title", () => {
    mocks.items = [itemRow({ value: "managemental-services" })];
    act(() => {
      root.unmount();
    });
    container.remove();
    mountPanel();

    clickInPanel(`button[aria-label="${t["common.edit"]}"]`);
    const valueInput = editingInputs()[0];
    // The floor lock and roof detection read this value; a Settings rename
    // would silently unlock them, so only labels stay editable.
    expect(valueInput.disabled).toBe(true);
    expect(valueInput.title).toBe(t["lists.valueCodeBound"]);
  });
});
