import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCardVisibility } from "@/hooks/useCardVisibility";
import { dictionaries } from "@/i18n/dictionary";
import { CARD_PAGE_LABEL_KEYS, CARD_REGISTRY, cardsByPage } from "@/lib/cardRegistry";

describe("resolveCardVisibility", () => {
  it("treats a card with no stored row as visible", () => {
    expect(resolveCardVisibility([])("dashboard.outstanding")).toBe(true);
  });

  it("hides only the cards whose row says is_visible false", () => {
    const isVisible = resolveCardVisibility([
      { card_id: "dashboard.outstanding", is_visible: false },
      { card_id: "tenants.total", is_visible: true },
    ]);
    expect(isVisible("dashboard.outstanding")).toBe(false);
    expect(isVisible("tenants.total")).toBe(true);
    expect(isVisible("units.total")).toBe(true);
  });
});

describe("CARD_REGISTRY", () => {
  it("gives every card a unique id", () => {
    const ids = CARD_REGISTRY.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prefixes every card id with its own page", () => {
    for (const card of CARD_REGISTRY) {
      expect(card.id.startsWith(`${card.page}.`), `${card.id} is not under ${card.page}`).toBe(
        true,
      );
    }
  });

  it("resolves every card label in both locales", () => {
    for (const card of CARD_REGISTRY) {
      expect(dictionaries.en[card.labelKey], `en:${card.labelKey}`).toBeTruthy();
      expect(dictionaries.ar[card.labelKey], `ar:${card.labelKey}`).toBeTruthy();
    }
  });

  it("resolves every page heading in both locales", () => {
    for (const labelKey of Object.values(CARD_PAGE_LABEL_KEYS)) {
      expect(dictionaries.en[labelKey], `en:${labelKey}`).toBeTruthy();
      expect(dictionaries.ar[labelKey], `ar:${labelKey}`).toBeTruthy();
    }
  });

  it("places every card in exactly one page group", () => {
    const grouped = cardsByPage().flatMap((group) => group.cards);
    expect(grouped).toHaveLength(CARD_REGISTRY.length);
  });
});

/**
 * يعزل mutationFn الخاص بـ useSetCardVisibility ويثبت أنّ payload يحمل company_id.
 *
 * The company_id term was what made migration 126's policy unsatisfiable: the
 * hook sends it, the policy checked it, and profiles.company_id was NULL for
 * every user so no row could ever match. A future refactor that drops
 * company_id from the upsert payload would silently reintroduce an
 * unsatisfiable write — this test pins the payload shape so that cannot happen.
 *
 * `useMutation` is captured rather than rendered: this repo has no `renderHook`
 * setup, and the mutationFn is the only thing under test — the react-query
 * plumbing is not what would break.
 */

const upsertMock = vi.fn((_payload: unknown, _options?: unknown) => ({ error: null }));
const fromMock = vi.fn((_table: string) => ({ upsert: upsertMock }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => fromMock(table) },
}));

const companyState = { data: { id: "company-1" } as { id: string } | null, isLoading: false };
vi.mock("@/hooks/useCompany", () => ({
  useCompany: () => companyState,
}));

let capturedMutationFn: ((args: { cardId: string; isVisible: boolean }) => Promise<void>) | null =
  null;
vi.mock("@tanstack/react-query", () => ({
  useMutation: (opts: {
    mutationFn: (args: { cardId: string; isVisible: boolean }) => Promise<void>;
  }) => {
    capturedMutationFn = opts.mutationFn;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, isLoading: false, error: null }),
}));

const { useSetCardVisibility } = await import("@/hooks/useCardVisibility");

describe("useSetCardVisibility upsert payload", () => {
  beforeEach(() => {
    upsertMock.mockReset();
    upsertMock.mockReturnValue({ error: null });
    fromMock.mockClear();
    companyState.data = { id: "company-1" };
    capturedMutationFn = null;
    useSetCardVisibility();
  });

  it("sends company_id, card_id, and is_visible so a dropped company_id fails this test", async () => {
    expect(capturedMutationFn).not.toBeNull();
    await capturedMutationFn!({ cardId: "dashboard.outstanding", isVisible: false });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [payload, options] = upsertMock.mock.calls[0]!;
    expect(payload).toEqual({
      company_id: "company-1",
      card_id: "dashboard.outstanding",
      is_visible: false,
    });
    // Composite-key conflict target must be stated explicitly for supabase-js.
    expect(options).toEqual({ onConflict: "company_id,card_id" });
  });

  it("throws when no company is configured rather than writing a null company_id", async () => {
    companyState.data = null;
    useSetCardVisibility();
    expect(capturedMutationFn).not.toBeNull();
    await expect(
      capturedMutationFn!({ cardId: "dashboard.outstanding", isVisible: true }),
    ).rejects.toThrow();
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
