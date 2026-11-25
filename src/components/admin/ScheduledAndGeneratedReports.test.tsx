/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك شاشة التقارير المجدولة والمولَّدة قبل تقسيمها إلى لوحتين.
 *
 * Audit M27 splits this 597-line component into a schedules panel and a
 * generated-reports panel. The split must not change behaviour, and until now
 * nothing rendered this screen under test: these cases pin the parts a
 * decomposition is most likely to break — both sections still render, "Add
 * schedule" opens an empty dialog, "Edit" opens it pre-filled with that row,
 * and saving an edit updates that row rather than creating a new one.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  schedule: {
    id: "sched-1",
    code: "MONTHLY-AR",
    frequency: "monthly",
    is_active: true,
    locale: "ar",
    name_ar: "تقرير شهري",
    name_en: "Monthly report",
    recipients: ["owner@example.com"],
  },
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));

vi.mock("@/hooks/useReportSchedules", () => ({
  useReportSchedules: () => ({
    data: { items: [mocks.schedule], count: 1 },
    isLoading: false,
    isError: false,
  }),
  useCreateReportSchedule: () => ({ mutateAsync: mocks.createSchedule, isPending: false }),
  useUpdateReportSchedule: () => ({ mutateAsync: mocks.updateSchedule, isPending: false }),
  useDeleteReportSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRunReportSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useGeneratedReports", () => ({
  useGeneratedReports: () => ({
    data: { items: [{ id: "gen-1" }], count: 1 },
    isLoading: false,
    isError: false,
  }),
  useResendGeneratedReport: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteGeneratedReport: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The two tables were extracted earlier and are not what this split moves;
// a stub that exposes the row callbacks is enough to drive the dialogs.
vi.mock("@/components/admin/ScheduledReportsTable", () => ({
  ScheduledReportsTable: ({
    onEdit,
    items,
  }: {
    onEdit: (row: unknown) => void;
    items: unknown[];
  }) => (
    <button type="button" data-testid="edit-schedule" onClick={() => onEdit(items[0])}>
      edit
    </button>
  ),
}));
vi.mock("@/components/admin/GeneratedReportsTable", () => ({
  GeneratedReportsTable: () => <div data-testid="generated-table" />,
}));
vi.mock("@/components/admin/GeneratedReportPreviewDialog", () => ({
  GeneratedReportPreviewDialog: () => null,
}));
vi.mock("@/components/admin/BulkDeleteBar", () => ({ BulkDeleteBar: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ScheduledAndGeneratedReports } =
  await import("@/components/admin/ScheduledAndGeneratedReports");

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب الشاشة داخل مزوّد الترجمة بالإنجليزية. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <ScheduledAndGeneratedReports />
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

/** يعثر على زر بنصه الظاهر في المستند كله (الحوارات تُرسم في بوابة). */
function buttonByText(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!match) throw new Error(`No button with text "${text}"`);
  return match as HTMLButtonElement;
}

/** قيم حقول الإدخال داخل الحوار المفتوح. */
function dialogInputValues(): string[] {
  const dialog = document.querySelector('[role="dialog"]');
  return [...(dialog?.querySelectorAll("input") ?? [])].map((input) => input.value);
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.createSchedule.mockReset().mockResolvedValue({});
  mocks.updateSchedule.mockReset().mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("scheduled and generated reports", () => {
  it("renders both the schedules section and the generated-reports section", async () => {
    mount();
    await settle();

    expect(document.body.textContent).toContain(en["reports.schedules"]);
    expect(document.body.textContent).toContain(en["reports.generated"]);
    expect(document.querySelector('[data-testid="generated-table"]')).not.toBeNull();
  });

  it("opens an empty add-schedule dialog", async () => {
    mount();
    await settle();

    act(() => buttonByText(en["reports.addSchedule"]).click());
    await settle();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(en["reports.addSchedule"]);
    expect(dialogInputValues()).not.toContain(mocks.schedule.code);
  });

  it("opens the dialog pre-filled from the row being edited", async () => {
    mount();
    await settle();

    act(() =>
      (document.querySelector('[data-testid="edit-schedule"]') as HTMLButtonElement).click(),
    );
    await settle();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(en["reports.editSchedule"]);
    expect(dialogInputValues()).toEqual(
      expect.arrayContaining([mocks.schedule.code, mocks.schedule.name_ar, "owner@example.com"]),
    );
  });

  it("saving an edit updates that schedule instead of creating another", async () => {
    mount();
    await settle();

    act(() =>
      (document.querySelector('[data-testid="edit-schedule"]') as HTMLButtonElement).click(),
    );
    await settle();
    await act(async () => {
      buttonByText(en["common.save"]).click();
    });
    await settle();

    expect(mocks.createSchedule).not.toHaveBeenCalled();
    expect(mocks.updateSchedule).toHaveBeenCalledWith({
      id: mocks.schedule.id,
      updates: expect.objectContaining({
        code: mocks.schedule.code,
        recipients: ["owner@example.com"],
        is_active: true,
      }),
    });
  });

  it("an add after an edit starts empty, not with the edited row's values", async () => {
    // The split moves the draft next to the dialog; a draft that survived
    // between opens would pre-fill "Add" with the last schedule edited.
    mount();
    await settle();

    act(() =>
      (document.querySelector('[data-testid="edit-schedule"]') as HTMLButtonElement).click(),
    );
    await settle();
    act(() => buttonByText(en["common.cancel"]).click());
    await settle();
    act(() => buttonByText(en["reports.addSchedule"]).click());
    await settle();

    expect(dialogInputValues()).not.toContain(mocks.schedule.code);
  });
});
