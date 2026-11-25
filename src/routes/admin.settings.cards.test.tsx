/**
 * @vitest-environment jsdom
 *
 * Toggle has to fire a real change event. The suite's default environment is
 * `node`, and `renderToStaticMarkup` cannot click. jsdom is already a dev
 * dependency for the other DOM-only tests.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { CARD_PAGE_LABEL_KEYS, CARD_REGISTRY, cardsByPage } from "@/lib/cardRegistry";

const { isCardVisible, mutate } = vi.hoisted(() => ({
  isCardVisible: vi.fn((_cardId: string) => true),
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: { component: unknown }) => opts,
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({
    isLoading: false,
    isAdmin: true,
    can: () => true,
  }),
}));

vi.mock("@/hooks/useCardVisibility", () => ({
  useCardVisibility: () => ({
    isCardVisible,
    isLoading: false,
    error: null,
  }),
  useSetCardVisibility: () => ({
    mutate,
    isPending: false,
  }),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    disabled,
    id,
  }: {
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
    disabled?: boolean;
    id?: string;
  }) => (
    <input
      type="checkbox"
      id={id}
      checked={Boolean(checked)}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

import { CardsControlPage } from "@/routes/admin.settings.cards";
import { I18nProvider } from "@/i18n/provider";

/**
 * يركّب شاشة التحكم في البطاقات في جذر React حي حتى يعمل النقر.
 */
function mountPage(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <CardsControlPage />
      </I18nProvider>,
    );
  });
  return { container, root };
}

describe("Cards control screen", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    isCardVisible.mockImplementation(() => true);
    mutate.mockReset();
    ({ container, root } = mountPage());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders a group for every page in the registry", () => {
    for (const key of Object.values(CARD_PAGE_LABEL_KEYS)) {
      expect(container.textContent).toContain(dictionaries.ar[key]);
    }
    expect(cardsByPage()).toHaveLength(Object.keys(CARD_PAGE_LABEL_KEYS).length);
  });

  it("renders a checkbox for every registry card", () => {
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(CARD_REGISTRY.length);
    for (const card of CARD_REGISTRY) {
      expect(container.textContent).toContain(dictionaries.ar[card.labelKey]);
    }
  });

  it("lists the four portal KPI toggles", () => {
    // The portal cards land with their flags in one commit; a registry entry
    // without a rendered toggle is configuration that can never be switched.
    for (const key of [
      "settings.cards.portal.insurance",
      "settings.cards.portal.nextDue",
      "settings.cards.portal.overdueInvoices",
      "settings.cards.portal.totalOverdue",
    ] as const) {
      expect(container.textContent).toContain(dictionaries.ar[key]);
    }
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(CARD_REGISTRY.length);
  });

  it("calls the mutation once with the card id and isVisible false", () => {
    const first = container.querySelector("input[type='checkbox']");
    expect(first).toBeTruthy();
    act(() => {
      first!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    // First arg is the payload. The second is the options bag carrying onError,
    // which the screen must wire so a failed write is surfaced rather than
    // swallowed — checked separately so a future change cannot drop it silently.
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      cardId: CARD_REGISTRY[0].id,
      isVisible: false,
    });
    expect(typeof mutate.mock.calls[0]?.[1]?.onError).toBe("function");
  });
});
