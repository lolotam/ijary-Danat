/**
 * @vitest-environment jsdom
 *
 * Real useCardVisibility; the concessions section is absent until the flag
 * read succeeds and the row (if any) leaves it visible.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

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

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: { component: unknown }) => opts,
}));

const { PortalLeaseConcessionsGate } = await import("@/routes/portal.lease");

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/**
 * ينتظر ظهور الابن المُبوَّب أو يتأكد من بقائه مخفياً طوال مهلة الاستقرار.
 */
async function waitForChild(present: boolean): Promise<void> {
  return waitForText("gated", present);
}

/**
 * ينتظر حتى يحتوي الحاوية على النص أو يخلو منه بعد مهلة استقرار.
 */
async function waitForText(text: string, present: boolean): Promise<void> {
  if (!present) {
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      if ((container.textContent ?? "").includes(text)) {
        throw new Error(`text appeared but should stay hidden: ${text}`);
      }
    }
    return;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if ((container.textContent ?? "").includes(text)) return;
  }
  throw new Error(`timed out waiting for present=${present} text=${text}`);
}

/**
 * يركّب بوابة قسم التنازلات الحقيقية حول ابن علامة.
 *
 * The gate is imported from the route module the portal renders, so what is
 * under test is production wiring; the child is a marker rather than a copy of
 * the real section, which would only re-assert SectionCard's own markup.
 */
function mount(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <PortalLeaseConcessionsGate>
            <p data-testid="concessions-child">gated</p>
          </PortalLeaseConcessionsGate>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("portal lease concessions gate", () => {
  it("hides the concessions section after a rejected flag read", async () => {
    visibility.outcome = { kind: "rejected" };
    mount();
    await waitForChild(false);
  });

  it("hides the concessions section while the flag read is pending", async () => {
    visibility.outcome = { kind: "pending" };
    mount();
    await waitForChild(false);
  });

  it("hides the concessions section when the flag is off", async () => {
    visibility.outcome = {
      kind: "success",
      rows: [{ card_id: "portal.leaseConcessions", is_visible: false }],
    };
    mount();
    await waitForChild(false);
  });

  it("shows the concessions section when the flag read succeeds with no hiding row", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    mount();
    await waitForChild(true);
  });
});
