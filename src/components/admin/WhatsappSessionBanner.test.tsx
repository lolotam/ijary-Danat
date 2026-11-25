/**
 * @vitest-environment jsdom
 *
 * شريط تحذير جلسة واتساب: الإخفاء عند الصحة أو الخطأ، وتفريع الأزرار حسب الصلاحيات.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import { PERMISSIONS, type PermissionCode } from "@/lib/permissions";
import type { WhatsappSessionHealth } from "@/lib/whatsappSessionBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  healthResult: {
    data: null as WhatsappSessionHealth | null,
    isError: false,
  },
  granted: new Set<PermissionCode>(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/useWhatsappSessionHealth", () => ({
  useWhatsappSessionHealth: () => mocks.healthResult,
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({
    can: (code: PermissionCode) => mocks.granted.has(code),
  }),
}));

const { WhatsappSessionBanner } = await import("@/components/admin/WhatsappSessionBanner");

let container: HTMLDivElement;
let root: Root;

function renderBanner() {
  act(() => {
    root.render(
      <I18nProvider>
        <WhatsappSessionBanner />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.healthResult = {
    data: {
      enabled: true,
      paired: true,
      state: "close",
      settling: false,
      disconnected_at: "2026-11-11T07:10:00Z",
      parked_count: 0,
    },
    isError: false,
  };
  mocks.granted = new Set();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WhatsappSessionBanner", () => {
  it("37: renders nothing when hidden or when the health query fails", () => {
    mocks.healthResult = {
      data: {
        enabled: true,
        paired: true,
        state: "open",
        settling: false,
        disconnected_at: null,
        parked_count: 0,
      },
      isError: false,
    };
    renderBanner();
    expect(container.innerHTML).toBe("");

    mocks.healthResult = {
      data: {
        enabled: true,
        paired: true,
        state: "close",
        settling: false,
        disconnected_at: "2026-11-11T07:10:00Z",
        parked_count: 3,
      },
      isError: true,
    };
    renderBanner();
    expect(container.innerHTML).toBe("");
  });

  it("38: links to /admin/settings/integrations with settings.integrations; shows askAdmin without link otherwise", () => {
    mocks.granted = new Set([PERMISSIONS.SETTINGS_INTEGRATIONS]);
    renderBanner();
    const link = container.querySelector('a[href="/admin/settings/integrations"]');
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe(dictionaries.ar["admin.whatsappBanner.reconnect"]);

    mocks.granted = new Set();
    renderBanner();
    expect(container.querySelector('a[href="/admin/settings/integrations"]')).toBeNull();
    expect(container.textContent).toContain(dictionaries.ar["admin.whatsappBanner.askAdmin"]);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("39: secondary link to /admin/settings/notifications renders only when parked_count > 0 and notifications.read is granted", () => {
    mocks.granted = new Set([PERMISSIONS.SETTINGS_INTEGRATIONS, PERMISSIONS.NOTIFICATIONS_READ]);
    mocks.healthResult.data!.parked_count = 0;
    renderBanner();
    expect(container.querySelector('a[href="/admin/settings/notifications"]')).toBeNull();

    mocks.healthResult.data!.parked_count = 4;
    renderBanner();
    const parkedLink = container.querySelector('a[href="/admin/settings/notifications"]');
    expect(parkedLink).toBeTruthy();
    expect(container.textContent).toContain(
      dictionaries.ar["admin.whatsappBanner.parked"].replace("{count}", "4"),
    );

    mocks.granted = new Set([PERMISSIONS.SETTINGS_INTEGRATIONS]);
    renderBanner();
    expect(container.querySelector('a[href="/admin/settings/notifications"]')).toBeNull();
  });

  it("40: shows neverPaired copy when paired is false", () => {
    mocks.healthResult.data = {
      enabled: true,
      paired: false,
      state: null,
      settling: false,
      disconnected_at: null,
      parked_count: 0,
    };
    renderBanner();
    expect(container.textContent).toContain(dictionaries.ar["admin.whatsappBanner.neverPaired"]);
  });
});
