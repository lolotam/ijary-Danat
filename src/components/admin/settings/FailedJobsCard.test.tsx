/**
 * @vitest-environment jsdom
 *
 * بطاقة المهام الفاشلة: عرض الصفوف، وإعادة المحاولة، وحالة الفراغ.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = dictionaries.ar;

const mocks = vi.hoisted(() => ({
  companyFailedJobs: vi.fn(),
  retryJob: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  canManageJobs: true,
}));

// The server functions are the browser's transport boundary; React Query and
// the toasts stay real.
vi.mock("@/fns/companyJobs", () => ({
  companyFailedJobs: mocks.companyFailedJobs,
  retryJob: mocks.retryJob,
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => mocks.canManageJobs, isLoading: false }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

const { FailedJobsCard } = await import("@/components/admin/settings/FailedJobsCard");

/** مهمة فاشلة واحدة كما يعيدها الخادم. */
const FAILED_JOB = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  kind: "invoice.send",
  lastError: "smtp timeout",
  attempts: 3,
  createdAt: "2026-11-20T10:00:00.000Z",
  finishedAt: "2026-11-20T10:05:00.000Z",
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/** يركّب البطاقة داخل مزوّد ترجمة عربية ومزوّد React Query حقيقي. */
function mount(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <FailedJobsCard />
        </I18nProvider>
      </QueryClientProvider>,
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

/** ينقر زر إعادة المحاولة في الصف الأول. */
function clickRetry(): void {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(t["settings.failedJobs.retry"]),
  );
  if (!button) throw new Error("retry button not found");
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canManageJobs = true;
  mocks.companyFailedJobs.mockResolvedValue([FAILED_JOB]);
  mocks.retryJob.mockResolvedValue({ id: FAILED_JOB.id });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("FailedJobsCard", () => {
  it("renders a row per failed job with its kind and its reason", async () => {
    mount();
    await flush();

    expect(container.textContent).toContain(t["jobKind.invoice.send"]);
    expect(container.textContent).toContain("smtp timeout");
  });

  it("clicking Retry retries that job and asks for the list again", async () => {
    mount();
    await flush();

    clickRetry();
    await flush();

    expect(mocks.retryJob).toHaveBeenCalledWith({ data: { id: FAILED_JOB.id } });
    // The retried row leaves the failed list, so the card has to read it again.
    expect(mocks.companyFailedJobs).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t["settings.failedJobs.retrySuccess"]);
  });

  it("an empty list shows the empty state and no row", async () => {
    mocks.companyFailedJobs.mockResolvedValue([]);
    mount();
    await flush();

    expect(container.textContent).toContain(t["settings.failedJobs.empty"]);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing for a caller without the company-settings permission", async () => {
    mocks.canManageJobs = false;
    mount();
    await flush();

    expect(container.textContent).toBe("");
    expect(mocks.companyFailedJobs).not.toHaveBeenCalled();
  });
});
