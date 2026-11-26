/**
 * @vitest-environment jsdom
 *
 * Real useCardVisibility under QueryClientProvider. A mock of the hook would
 * let the dialog open on a failed read, which is the defect the fail-closed
 * gate exists to prevent.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY, dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ARABIC_BODY =
  "يرجى مراجعة مكتب شؤون المستهلكين لوزارة الكهرباء والماء وسداد جميع المبالغ المستحقة.";

type VisibilityOutcome =
  | { kind: "pending" }
  | { kind: "rejected" }
  | { kind: "success"; rows: Array<{ card_id: string; is_visible: boolean }> };

const visibility = vi.hoisted(() => ({
  outcome: { kind: "pending" } as VisibilityOutcome,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "companies") {
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: "company-1" }, error: null }),
          }),
        };
      }
      if (table === "card_visibility") {
        return {
          select: () => ({
            eq: () => {
              if (visibility.outcome.kind === "pending") return new Promise(() => undefined);
              if (visibility.outcome.kind === "rejected") {
                return Promise.resolve({ data: null, error: new Error("visibility boom") });
              }
              return Promise.resolve({ data: visibility.outcome.rows, error: null });
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

const { ReminderPopupDialog } = await import("./ReminderPopupDialog");

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/**
 * ينتظر حتى يظهر الحوار أو يغيب، مع ضخ دورات React بينها.
 */
async function waitForDialog(present: boolean): Promise<void> {
  if (!present) {
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      if (document.querySelector("[role='dialog']")) {
        throw new Error("dialog appeared but should stay hidden");
      }
    }
    return;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (document.querySelector("[role='dialog']")) return;
  }
  throw new Error(`timed out waiting for dialog present=${present}`);
}

/**
 * يركّب نافذة التذكير لمستأجر معيّن داخل مزوّدي الترجمة والاستعلام.
 */
function mount(tenantId = "tenant-1"): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  renderTenant(tenantId);
}

/** يبدّل المستأجر على الجذر نفسه لكشف تسرب حالة إغلاق نافذة الهوية السابقة. */
function renderTenant(tenantId: string): void {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ReminderPopupDialog tenantId={tenantId} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  visibility.outcome = { kind: "pending" };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("ReminderPopupDialog", () => {
  it("reads each tenant's dismissal when identity changes without unmounting", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    sessionStorage.setItem("portal.reminderPopup.dismissed:tenant-1", "1");
    mount("tenant-1");
    await waitForDialog(false);
    renderTenant("tenant-2");
    await waitForDialog(true);
    renderTenant("tenant-1");
    await waitForDialog(false);
  });

  it("renders nothing while the flag read is pending", async () => {
    visibility.outcome = { kind: "pending" };
    mount();
    await waitForDialog(false);
  });

  it("renders nothing after a rejected flag read", async () => {
    visibility.outcome = { kind: "rejected" };
    mount();
    await waitForDialog(false);
  });

  it("renders nothing when the flag row is explicitly off", async () => {
    visibility.outcome = {
      kind: "success",
      rows: [{ card_id: "portal.reminderPopup", is_visible: false }],
    };
    mount();
    await waitForDialog(false);
  });

  it("shows the instruction as the accessible description when no row hides it", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    mount();
    await waitForDialog(true);
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).toBeTruthy();
    const describedBy = dialog?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(ARABIC_BODY);
  });

  it("writes a per-tenant dismissal that a remount in the same tab honours", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    mount("tenant-1");
    await waitForDialog(true);
    const understood = Array.from(document.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes(dictionaries.ar["portal.reminder.understood"]),
    );
    expect(understood).toBeTruthy();
    act(() => {
      understood!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sessionStorage.getItem("portal.reminderPopup.dismissed:tenant-1")).toBe("1");

    act(() => root.unmount());
    container.remove();
    mount("tenant-1");
    await waitForDialog(false);
  });

  it("still shows the dialog when sessionStorage getItem throws", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    // Spy on the PROTOTYPE: jsdom's `sessionStorage` is a Proxy whose own
    // properties are the stored keys, so spying on the instance replaces
    // nothing and the test would pass without ever reaching a throwing store.
    const realGetItem = Storage.prototype.getItem;
    const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key.startsWith("portal.reminderPopup.dismissed:")) {
        throw new Error("storage blocked");
      }
      return realGetItem.call(this, key);
    });
    mount();
    await waitForDialog(true);
    expect(blocked).toHaveBeenCalledWith("portal.reminderPopup.dismissed:tenant-1");
  });
});
