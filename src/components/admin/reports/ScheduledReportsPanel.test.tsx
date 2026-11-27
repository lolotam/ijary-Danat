/**
 * @vitest-environment jsdom
 *
 * يثبت أن تشغيل جدول تقرير يقول «أُدرج في قائمة الانتظار» لا «تم التشغيل».
 *
 * T075: `runReportSchedule` لا يبنى التقرير anymore — it validates, checks the
 * permission, and files one `report.run` job for the worker (contracts/jobs.md
 * section 1). A toast that says the schedules "were run" reports work the
 * request never did, and hides the fact that the report only exists once the
 * worker has built it.
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
  runSchedule: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));

vi.mock("@/hooks/useReportSchedules", () => ({
  useReportSchedules: () => ({
    data: { items: [{ id: "sched-1", code: "MONTHLY-AR" }], count: 1 },
    isLoading: false,
    isError: false,
  }),
  useDeleteReportSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRunReportSchedule: () => ({ mutateAsync: mocks.runSchedule, isPending: false }),
}));

vi.mock("@/components/admin/ScheduledReportsTable", () => ({
  ScheduledReportsTable: ({
    items,
    onRun,
  }: {
    items: Array<{ id: string }>;
    onRun: (id: string) => void;
  }) => (
    <button type="button" data-testid="run-schedule" onClick={() => onRun(items[0].id)}>
      run
    </button>
  ),
}));

vi.mock("@/components/admin/reports/ScheduleDialog", () => ({
  ScheduleDialog: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

const { ScheduledReportsPanel } = await import("@/components/admin/reports/ScheduledReportsPanel");

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب لوحة الجداول داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <ScheduledReportsPanel />
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

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.runSchedule.mockReset().mockResolvedValue({ queued: true, jobRequestIds: ["job-1"] });
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("scheduled reports panel — running a schedule now", () => {
  it("reports the run as queued instead of done", async () => {
    mount();
    await settle();

    await act(async () => {
      (document.querySelector('[data-testid="run-schedule"]') as HTMLButtonElement).click();
    });
    await settle();

    expect(mocks.runSchedule).toHaveBeenCalledWith("sched-1");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(en["deferred.reportQueued"]);
    // The old wording claimed the request had built and sent the reports.
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(en["reports.scheduleDone"]);
  });
});
