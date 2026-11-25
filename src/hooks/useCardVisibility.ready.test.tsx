/**
 * @vitest-environment jsdom
 *
 * isReady must be driven by the real hook under QueryClient: a mock of
 * useCardVisibility would not catch a regression that treats a failed read as
 * ready. Supabase is stubbed at the client boundary only.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
            order: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: { id: "company-1" }, error: null }),
              }),
            }),
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

const { useCardVisibility } = await import("@/hooks/useCardVisibility");

/**
 * يقرأ isReady و isCardVisible من الخطاف الحقيقي ويعرضهما كنص.
 */
function Probe() {
  const { isReady, isCardVisible } = useCardVisibility();
  return (
    <div>
      <span data-testid="ready">{String(isReady)}</span>
      <span data-testid="visible">{String(isCardVisible("portal.reminderPopup"))}</span>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/**
 * يركّب مسبار الرؤية داخل مزوّد استعلام بلا إعادة محاولة.
 */
function mount(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

/**
 * ينتظر حتى يطابق نص مسبار ما القيمة المتوقعة، مع ضخ دورات React بينها.
 */
async function waitForProbe(testId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (container.querySelector(`[data-testid='${testId}']`)?.textContent === expected) return;
  }
  throw new Error(
    `timed out waiting for ${testId}=${expected}, got ${container.querySelector(`[data-testid='${testId}']`)?.textContent}`,
  );
}

beforeEach(() => {
  visibility.outcome = { kind: "pending" };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("useCardVisibility isReady", () => {
  it("is false while the flag read is still pending", async () => {
    visibility.outcome = { kind: "pending" };
    mount();
    await waitForProbe("ready", "false");
  });

  it("is false after a rejected flag read, and isCardVisible stays true (admin default)", async () => {
    visibility.outcome = { kind: "rejected" };
    mount();
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(["card-visibility", "company-1"])?.status).toBe("error");
    });
    await waitForProbe("ready", "false");
    await waitForProbe("visible", "true");
  });

  it("is true after both the company and flag reads succeed", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    mount();
    await waitForProbe("ready", "true");
  });
});
