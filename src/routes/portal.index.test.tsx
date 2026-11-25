/**
 * @vitest-environment jsdom
 *
 * Real useCardVisibility; the compose form is absent until the flag read
 * succeeds and the row (if any) leaves it visible.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
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
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/components/portal/ContractSwitcher", () => ({
  ContractSwitcher: () => null,
}));

vi.mock("@/hooks/usePortalContractSelection", () => ({
  usePortalContractSelection: () => ({ contractId: null }),
}));

vi.mock("@/hooks/useLinkedBrand", () => ({
  useBrandsForTenantContracts: () => ({ data: [] }),
  brandForSelectedContract: () => null,
}));

const portalData = vi.hoisted(() => ({
  identity: {
    data: { tenant: { id: "tenant-1", name: "Sara Ali", name_en: null } },
    isLoading: false,
  },
  lease: {
    isLoading: false,
    isError: false,
    data: { contract: null, units: [], properties: [], concessions: [] },
  },
  summary: {
    isLoading: false,
    isError: false,
    data: { overdueCount: 1, nextDue: "2026-02-01", overdueTotal: 175.5 },
  },
  insurance: { isLoading: false, isError: false, data: 200 },
}));

vi.mock("@/hooks/usePortalData", () => ({
  usePortalIdentity: () => portalData.identity,
  usePortalLease: () => portalData.lease,
  usePortalInvoiceSummary: () => portalData.summary,
  usePortalInsurancePaid: () => portalData.insurance,
}));

const { PortalMessageComposeGate, Route } = await import("@/routes/portal.index");
const { formatKwd } = await import("@/lib/money");

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/**
 * يركّب بوابة نموذج المراسلة داخل مزوّدي الترجمة والاستعلام.
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
          <PortalMessageComposeGate tenantId="tenant-1" />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
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

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("portal index message compose gate", () => {
  it("hides the compose form after a rejected flag read", async () => {
    visibility.outcome = { kind: "rejected" };
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    mount();
    await waitForText(dictionaries.ar["portal.messages.title"], false);
  });

  it("hides the compose form while the flag read is pending", async () => {
    visibility.outcome = { kind: "pending" };
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    mount();
    await waitForText(dictionaries.ar["portal.messages.title"], false);
  });

  it("hides the compose form when the flag is off", async () => {
    visibility.outcome = {
      kind: "success",
      rows: [{ card_id: "portal.messageCompose", is_visible: false }],
    };
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    mount();
    await waitForText(dictionaries.ar["portal.messages.title"], false);
  });

  it("shows the compose form when the flag read succeeds with no hiding row", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    mount();
    await waitForText(dictionaries.ar["portal.messages.title"], true);
  });
});

/**
 * يركّب لوحة البوابة الكاملة (المكوّن المخزّن في Route).
 */
function mountDashboard(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const Dashboard = (Route as unknown as { component: () => ReactNode }).component;
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <Dashboard />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

describe("portal dashboard KPI wiring", () => {
  it("passes the invoice summary overdue total to the total-overdue card", async () => {
    // The card must show the summary's sum (175.5), not the count (1): a
    // dropped overdueTotal prop would render 0.000 KWD beside real arrears.
    visibility.outcome = { kind: "success", rows: [] };
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    mountDashboard();
    await waitForText(dictionaries.ar["portal.dashboard.totalOverdue"], true);
    await waitForText(formatKwd(175.5, "ar"), true);
  });

  it.each([
    ["hidden", false, false],
    ["visible", true, true],
  ])(
    "an insurance read failure with the insurance card %s shows the page error: %s",
    async (_label, cardVisible, expectError) => {
      // Codex review round 1 on PR #266: a card the office hid must not be able
      // to take the whole portal home page down through its own failed read.
      visibility.outcome = {
        kind: "success",
        rows: cardVisible ? [] : [{ card_id: "portal.insurance", is_visible: false }],
      };
      localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
      const loaded = portalData.insurance;
      portalData.insurance = { isLoading: false, isError: true, data: undefined as never };
      try {
        mountDashboard();
        await waitForText(dictionaries.ar["common.error"], expectError);
        if (!expectError) {
          await waitForText(dictionaries.ar["portal.dashboard.totalOverdue"], true);
        }
      } finally {
        portalData.insurance = loaded;
      }
    },
  );

  it("a failed flag read plus a failed insurance read still renders the page", async () => {
    // Codex review round 2 on PR #266: with the flag read rejected the KPI
    // cards render nothing, so their data reads must not gate the page.
    visibility.outcome = { kind: "rejected" };
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    const loaded = portalData.insurance;
    portalData.insurance = { isLoading: false, isError: true, data: undefined as never };
    try {
      mountDashboard();
      // Positive first: the page body rendered (not a skeleton that merely
      // lacks the error text), then no error and no KPI cards.
      await waitForText(dictionaries.ar["portal.dashboard.welcome"], true);
      await waitForText(dictionaries.ar["common.error"], false);
      expect(container.textContent).not.toContain(dictionaries.ar["portal.dashboard.totalOverdue"]);
      expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);
    } finally {
      portalData.insurance = loaded;
    }
  });

  it("shows a four-placeholder skeleton while the summary is loading", async () => {
    visibility.outcome = { kind: "success", rows: [] };
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    const loaded = portalData.summary;
    portalData.summary = { ...loaded, isLoading: true, data: undefined as never };
    try {
      mountDashboard();
      await waitForText(formatKwd(175.5, "ar"), false);
      expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
    } finally {
      portalData.summary = loaded;
    }
  });
});
