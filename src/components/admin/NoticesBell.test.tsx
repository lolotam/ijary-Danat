/**
 * @vitest-environment jsdom
 *
 * جرس إشعارات المهام: العدد غير المقروء يظهر على الجرس، والنقر على إشعار
 * يعلّمه مقروءاً، والعنوان المجهول يعود إلى نوع المهمة.
 *
 * The dropdown content is portaled, so it only renders once the menu is open
 * — the same jsdom technique as GalleryTable.test.tsx.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  notices: [] as Array<{
    id: string;
    kind: string;
    titleKey: string;
    level: "success" | "error";
    readAt: string | null;
    createdAt: string;
  }>,
  markRead: vi.fn(),
}));

vi.mock("@/hooks/useNotices", () => ({
  useNotices: () => ({ data: mocks.notices }),
  useMarkNoticeRead: () => ({ mutate: mocks.markRead }),
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ isStaff: true, isLoading: false }),
}));

const { NoticesBell } = await import("@/components/admin/NoticesBell");

/** إشعار واحد للاختبار. */
function notice(overrides: Partial<(typeof mocks.notices)[number]> = {}) {
  return {
    id: "n1",
    kind: "invoices.generate",
    titleKey: "notices.invoices.generate.success",
    level: "success" as const,
    readAt: null,
    createdAt: "2026-11-27T10:00:00Z",
    ...overrides,
  };
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

/** يركّب الجرس داخل مزوّد i18n حقيقي (العربية هي الافتراضية). */
function mountBell() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <NoticesBell />
      </I18nProvider>,
    );
  });
  roots.push({ root, container });
  return container;
}

/**
 * يفتح قائمة الجرس عبر لوحة المفاتيح ثم يعيد بنودها.
 *
 * Radix's trigger opens on ArrowDown keydown — the event jsdom can dispatch
 * without a pointer-events shim.
 */
function openMenu(): Element[] {
  const trigger = document.querySelector('[aria-haspopup="menu"]');
  expect(trigger, "the bell trigger should render").toBeTruthy();
  act(() => {
    trigger!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
  });
  return [...document.querySelectorAll('[role="menuitem"]')];
}

beforeEach(() => {
  mocks.notices = [];
  mocks.markRead.mockClear();
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

describe("NoticesBell", () => {
  it("shows how many notices are still unread", () => {
    mocks.notices = [
      notice({ id: "n1" }),
      notice({ id: "n2" }),
      notice({ id: "n3", readAt: "2026-11-27T09:00:00Z" }),
    ];

    const container = mountBell();

    expect(container.textContent?.trim()).toBe("2");
  });

  it("marks a notice read when it is chosen", () => {
    mocks.notices = [notice({ id: "n1" })];
    mountBell();

    const items = openMenu();
    const item = items.find((element) => element.textContent?.includes("تم إنشاء"));
    expect(item, "the notice should be listed with its translated title").toBeTruthy();
    act(() => {
      item!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(mocks.markRead).toHaveBeenCalledWith("n1");
  });

  it("falls back to the raw job kind when the title key is unknown", () => {
    mocks.notices = [notice({ id: "n1", titleKey: "notices.something.unknown.success" })];
    mountBell();

    const items = openMenu();

    expect(items[0]?.textContent).toContain("invoices.generate");
  });
});
