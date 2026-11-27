/**
 * @vitest-environment jsdom
 *
 * قاعدة R4: جلسة المتصفح تُحفظ في localStorage لكل أصل منفصل، ولا يجوز أن
 * يُضبط أي كوكي بنطاق نطاقٍ أب (مثل `Domain=.ijary.app`)، لأنه بذلك يُشارك
 * الحالة — ومستقبلاً الجلسة — بين عناوين كل الشركات.
 *
 * Three pieces of evidence for one rule: a scan of production sources, the one
 * real cookie write in the app (the sidebar state), and the real auth session
 * path (the Supabase browser client). Anything that later adds a parent-domain
 * cookie — a Set-Cookie in a server function, a `document.cookie`, or a cookie
 * auth bridge — is caught by one of the three.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider } from "@/components/ui/sidebar";

// No @testing-library here: React's act() needs this flag to know it runs in a
// test environment, otherwise every call logs a warning (harmless but noisy).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** دالة استعادة التقاط كتابة الكوكيز، تُستدعى بعد كل اختبار. */
let restoreCookieCapture: (() => void) | null = null;

afterEach(() => {
  restoreCookieCapture?.();
  restoreCookieCapture = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * يجمع مسارات ملفات الشيفرة الإنتاجية (غير الاختبارات) تحت مجلد.
 *
 * Same enumeration as companyUrl.test.ts; the two scans assert different rules
 * and neither file may grow a shared import for the other's sake.
 */
function productionSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return productionSources(path);
    const isSource = /\.(ts|tsx)$/.test(name) && !/\.(test|sqltest|testkit)\./.test(name);
    return isSource ? [path] : [];
  });
}

/**
 * يلتقط نصوص كتابة `document.cookie` الخام قبل أن يختفي السمات داخل متصفح jsdom.
 *
 * `document.cookie` hands back only `name=value`, so a `Domain=` attribute is
 * invisible through the getter; wrapping the setter is the only way to observe
 * what the code actually wrote.
 */
function captureCookieWrites(): string[] {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  Object.defineProperty(Document.prototype, "cookie", {
    configurable: true,
    get: original.get,
    set(value: string) {
      writes.push(value);
      original.set!.call(document, value);
    },
  });
  restoreCookieCapture = () => Object.defineProperty(Document.prototype, "cookie", original);
  return writes;
}

/**
 * يركّب `window.matchMedia` وهمياً لبيئة jsdom بنتيجة سطح المكتب.
 *
 * Same shape as index.test.tsx; jsdom has no matchMedia and the sidebar state
 * hook calls it on mount.
 */
function stubDesktopMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * يبني رمز JWT غير موقّع صالح القراءة.
 *
 * `setSession` decodes `exp` before any network call, so the token must look
 * like a live JWT even though nothing verifies its signature here.
 */
function unsignedJwt(expiresAtSeconds: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { sub: "user-1", exp: expiresAtSeconds, role: "authenticated" };
  // decodeJWT regex-validates every segment as base64url (groups of 4, ending
  // in 2 or 3 characters), so the placeholder signature must be shaped too.
  return `${encode(header)}.${encode(payload)}.c2ln`;
}

/**
 * يقرأ كل القيم المخزنة في localStorage دفعة واحدة.
 *
 * Storage's named properties do not show up through `Object.values`, so the
 * spec's indexed accessors are the reliable read.
 */
function localStorageValues(): string {
  const values: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    values.push(localStorage.getItem(key!) ?? "");
  }
  return values.join("\n");
}

describe("no response sets a cookie with a parent-domain scope", () => {
  it("no production source carries a parent-domain Domain attribute", () => {
    // RFC 6265 ignores a leading dot, so `Domain=ijary.app` scopes a cookie to
    // every company's subdomain exactly like `Domain=.ijary.app` does.
    const offenders: string[] = [];
    for (const dir of ["src", "server"]) {
      for (const path of productionSources(join(process.cwd(), dir))) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, index) => {
            for (const match of line.matchAll(/\bdomain\s*=\s*["']?([^"';\s,)]+)/gi)) {
              const value = match[1].toLowerCase();
              if (value.startsWith(".") || value === "ijary.app") {
                offenders.push(`${path}:${index + 1}: Domain=${match[1]}`);
              }
            }
          });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the sidebar toggle writes a host-only cookie with no Domain attribute", async () => {
    stubDesktopMatchMedia();
    const writes = captureCookieWrites();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(createElement(SidebarProvider));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    });

    root.unmount();
    container.remove();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^sidebar_state=(true|false); path=\/; max-age=\d+$/);
    expect(writes.join("\n")).not.toMatch(/domain\s*=/i);
  });

  it("the browser client keeps its session in localStorage and writes no cookie", async () => {
    vi.stubEnv("SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    const writes = captureCookieWrites();
    const accessToken = unsignedJwt(Math.floor(Date.now() / 1000) + 3600);
    // The only network call `setSession` makes: fetching the token's user.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "user-1",
              aud: "authenticated",
              role: "authenticated",
              email: "person@example.test",
              created_at: "2026-01-01T00:00:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const { supabase } = await import("@/integrations/supabase/client");
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: "refresh-token",
    });

    expect(error).toBeNull();
    expect(writes).toEqual([]);
    expect(localStorageValues()).toContain(accessToken);
  });
});
