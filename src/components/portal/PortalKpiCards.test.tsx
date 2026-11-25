/**
 * @vitest-environment jsdom
 *
 * بطاقات مؤشرات البوابة: كل بطاقة محجوبة بعلمها، والشبكة تملأ العرض المتاح.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = dictionaries.ar;

const visibility = vi.hoisted(() => ({
  ready: true,
  error: null as Error | null,
  hidden: new Set<string>(),
}));

vi.mock("@/hooks/useCardVisibility", () => ({
  useCardVisibility: () => ({
    isReady: visibility.ready,
    error: visibility.error,
    isCardVisible: (cardId: string) => !visibility.hidden.has(cardId),
  }),
}));

const { PortalKpiCards, kpiGridClass } = await import("@/components/portal/PortalKpiCards");

const PROPS = {
  insurancePaid: 200,
  nextDue: "2026-02-01",
  overdueCount: 1,
  overdueTotal: 175.5,
};

let container!: HTMLDivElement;
let root!: Root;

/** يركّب البطاقات داخل مزوّد الترجمة العربية. */
function mountCards(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <PortalKpiCards {...PROPS} />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  visibility.ready = true;
  visibility.error = null;
  visibility.hidden = new Set<string>();
});

afterEach(() => {
  if (!container) return;
  act(() => root.unmount());
  container.remove();
  container = undefined as never;
});

describe("kpiGridClass", () => {
  it.each([
    [1, "grid gap-5 grid-cols-1"],
    [2, "grid gap-5 grid-cols-1 md:grid-cols-2"],
    [3, "grid gap-5 grid-cols-1 md:grid-cols-3"],
    [4, "grid gap-5 grid-cols-1 md:grid-cols-2 xl:grid-cols-4"],
  ])("renders %i visible cards with %s", (count, expected) => {
    // Full literal classes — Tailwind only generates classes it can see, so a
    // computed `md:grid-cols-${count}` would silently lose its styling.
    expect(kpiGridClass(count)).toBe(expected);
  });
});

describe("PortalKpiCards visibility", () => {
  it("renders all four cards in a four-column grid when every flag is on", () => {
    mountCards();

    // A missing card here means its flag gate swallowed a card the office left
    // switched on.
    expect(container.textContent).toContain(t["portal.dashboard.insurancePaid"]);
    expect(container.textContent).toContain(t["portal.dashboard.nextDue"]);
    expect(container.textContent).toContain(t["portal.dashboard.overdueCount"]);
    expect(container.textContent).toContain(t["portal.dashboard.totalOverdue"]);
    expect(container.querySelector("section")?.className).toContain("xl:grid-cols-4");
  });

  it("shows the overdue sum on the total card, not the invoice count", () => {
    mountCards();

    // overdueCount is 1 and overdueTotal is 175.5: if the card read the count,
    // it would print a 1 where the office owes the tenant a sum.
    expect(container.textContent).toContain(formatKwd(PROPS.overdueTotal, "ar"));
    expect(container.textContent).toContain(t["portalHome.totalOverdueHint"]);
  });

  it("shrinks to a two-column grid when two flags are off", () => {
    visibility.hidden = new Set(["portal.nextDue", "portal.overdueInvoices"]);
    mountCards();

    expect(container.textContent).toContain(t["portal.dashboard.insurancePaid"]);
    expect(container.textContent).toContain(t["portal.dashboard.totalOverdue"]);
    // Absence is asserted on the hidden cards' hints: the overdue-count label
    // ("الفواتير المتأخرة") is a substring of the total card's hint, so a
    // label assertion could never go red for the right reason.
    expect(container.textContent).not.toContain(t["portalHome.nextUpcomingDueDate"]);
    expect(container.textContent).not.toContain(t["portalHome.requiresFollowUp"]);
    const sectionClass = container.querySelector("section")?.className ?? "";
    expect(sectionClass).toContain("md:grid-cols-2");
    expect(sectionClass).not.toContain("xl:grid-cols-4");
  });

  it("renders nothing when every flag is off", () => {
    visibility.hidden = new Set([
      "portal.insurance",
      "portal.nextDue",
      "portal.overdueInvoices",
      "portal.totalOverdue",
    ]);
    mountCards();

    // An empty grid box would leave a blank band on the tenant's home page.
    expect(container.textContent).toBe("");
    expect(container.querySelector("section")).toBeNull();
  });

  it("renders nothing, not an endless skeleton, when the flag read fails", () => {
    visibility.ready = false;
    visibility.error = new Error("card_visibility read failed");
    mountCards();

    // Still closed (no card can un-hide), but no permanent loading state.
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("renders the skeleton, not card values, while flags are loading", () => {
    visibility.ready = false;
    mountCards();

    // Fail closed: an unresolved read must not flash cards the office may have
    // switched off.
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
    expect(container.textContent).not.toContain(t["portal.dashboard.totalOverdue"]);
    expect(container.textContent).not.toContain(formatKwd(PROPS.overdueTotal, "ar"));
  });
});
