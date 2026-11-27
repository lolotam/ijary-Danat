/**
 * @vitest-environment jsdom
 *
 * شريط جلسة الدعم الفني: يظهر داخل لوحة الشركة ما دامت الجلسة مفتوحة، ويسمّي
 * مشرف المنصة وسبب الدخول، ويعرض زر إنهاء الجلسة.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import type { SupportSessionContext } from "@/platform/supportSessionFns";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  accessToken: "support-token" as string | null,
  context: { active: false } as SupportSessionContext,
  endPanel: vi.fn(),
  readContext: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    session: mocks.accessToken ? { access_token: mocks.accessToken } : null,
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: mocks.signOut } },
}));

vi.mock("@/platform/supportSessionFns", () => ({
  readSupportSessionContext: () => mocks.readContext(),
  endSupportSessionFromPanel: () => mocks.endPanel(),
  supportSessionErrorMessage: (t: (key: string) => string) =>
    t("supportSession.platform.error.generic"),
}));

const { SupportSessionBanner } = await import("@/components/admin/SupportSessionBanner");

/**
 * النص كما يظهر في الشريط: من كتالوج الترجمة، أو المفتاح نفسه قبل ربطه.
 *
 * The catalog wiring lands with the merge, and `t()` answers the key itself
 * until then, so the expectation follows whichever of the two is on screen.
 */
function label(key: string): string {
  return dictionaries.ar[key] ?? key;
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

/** يركّب الشريط داخل مزوّد i18n حقيقي (العربية هي الافتراضية). */
function mountBanner(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <SupportSessionBanner />
      </I18nProvider>,
    );
  });
  roots.push({ root, container });
  return container;
}

/** جلسة دعم مفتوحة كما يقرؤها الخادم. */
function openContext(): SupportSessionContext {
  return {
    active: true,
    sessionId: "55555555-5555-4555-8555-555555555555",
    reason: "مراجعة الفواتير",
    adminName: "دعم المنصة",
    expiresAt: "2026-11-27T12:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accessToken = "support-token";
  mocks.context = openContext();
  mocks.readContext.mockImplementation(async () => mocks.context);
  mocks.endPanel.mockResolvedValue({ sessionId: "s1", endedAt: "2026-11-27T11:00:00.000Z" });
  mocks.signOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  while (roots.length) {
    const { root, container } = roots.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  document.body.innerHTML = "";
});

describe("SupportSessionBanner", () => {
  it("renders nothing without a session", async () => {
    mocks.accessToken = null;

    const container = mountBanner();
    await act(async () => {});

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the session is not an open support session", async () => {
    mocks.context = { active: false };

    const container = mountBanner();
    await act(async () => {});

    expect(container.innerHTML).toBe("");
  });

  it("names the platform admin, the reason, and offers the end button", async () => {
    const container = mountBanner();
    await act(async () => {});

    expect(container.textContent).toContain(
      label("supportSession.banner.by").replace("{name}", "دعم المنصة"),
    );
    expect(container.textContent).toContain(
      label("supportSession.banner.reason").replace("{reason}", "مراجعة الفواتير"),
    );
    expect(container.querySelector('button[data-testid="support-session-end"]')).toBeTruthy();
  });

  it("ends the session and drops the browser session with it", async () => {
    const container = mountBanner();
    await act(async () => {});

    const button = container.querySelector('button[data-testid="support-session-end"]');
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(mocks.endPanel).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[data-testid="support-session-end"]')).toBeNull();
  });
});
