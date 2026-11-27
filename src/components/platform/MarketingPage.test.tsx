/**
 * @vitest-environment jsdom
 *
 * يتحقق من عرض صفحة التسويق الرئيسية للمنصة: الاتجاه العربي RTL،
 * وكتل الميزات الثلاث، ورابط تسجيل الدخول `/auth` (T196).
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { MarketingPage } from "./MarketingPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <MarketingPage />
      </I18nProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MarketingPage", () => {
  it("renders in Arabic RTL with the three feature blocks and sign-in link to /auth", () => {
    const wrapper = container.firstElementChild;
    expect(wrapper?.getAttribute("dir")).toBe("rtl");

    expect(container.querySelectorAll("article")).toHaveLength(3);

    const signInLinks = [...container.querySelectorAll('a[href="/auth"]')];
    expect(signInLinks.length).toBeGreaterThanOrEqual(1);
  });
});
