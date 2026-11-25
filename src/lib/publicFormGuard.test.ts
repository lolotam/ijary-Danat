import { beforeEach, describe, expect, test, vi } from "vitest";

import { clientAddress } from "@/lib/clientAddress";

// The limiter is module-level mutable state. A fresh copy per test — via
// resetModules plus a dynamic import — is what keeps one case's buckets from
// contaminating the next; the static clientAddress import is stateless and
// unaffected.
type Guard = typeof import("@/lib/publicFormGuard");

let guard: Guard;

beforeEach(async () => {
  vi.resetModules();
  guard = await import("@/lib/publicFormGuard");
});

describe("rateLimitPublicForm", () => {
  test("allows five submissions from one address and refuses the sixth", () => {
    const start = 1_800_000_000_000;
    const results = Array.from({ length: 6 }, () =>
      guard.rateLimitPublicForm("contact", "198.51.100.7", start),
    );

    expect(results).toEqual([false, false, false, false, false, true]);
  });

  test("a forged x-forwarded-for cannot mint a fresh bucket once cf-connecting-ip is fixed", () => {
    // Six requests sharing one true Cloudflare-observed address, each carrying
    // a different forged x-forwarded-for. The old limiter keyed on the forged
    // header, so every request landed in a fresh bucket and the sixth was
    // never refused — the H6 bypass this module exists to close.
    const results = Array.from({ length: 6 }, (_, i) => {
      const request = new Request("https://danat-future.test/fns/submitContactInquiry", {
        headers: {
          "cf-connecting-ip": "203.0.113.55",
          "x-forwarded-for": `10.0.0.${i + 1}`,
        },
      });
      return guard.rateLimitPublicForm("contact", clientAddress(request) ?? "unknown");
    });

    expect(results).toEqual([false, false, false, false, false, true]);
  });

  test("keeps the two endpoints' buckets independent", () => {
    for (let i = 0; i < 5; i++) {
      expect(guard.rateLimitPublicForm("contact", "198.51.100.7")).toBe(false);
    }
    // The contact bucket is full…
    expect(guard.rateLimitPublicForm("contact", "198.51.100.7")).toBe(true);
    // …yet the same address may still submit a leasing inquiry: five contact
    // submissions must not consume the leasing quota.
    expect(guard.rateLimitPublicForm("leasing", "198.51.100.7")).toBe(false);
  });

  test("keeps different addresses in different buckets", () => {
    for (let i = 0; i < 5; i++) {
      expect(guard.rateLimitPublicForm("contact", "198.51.100.1")).toBe(false);
    }
    expect(guard.rateLimitPublicForm("contact", "198.51.100.2")).toBe(false);
  });

  test("allows the address again once the window has passed", () => {
    const start = 1_800_000_000_000;
    for (let i = 0; i < 5; i++) {
      expect(guard.rateLimitPublicForm("leasing", "203.0.113.9", start + i * 1_000)).toBe(false);
    }
    expect(guard.rateLimitPublicForm("leasing", "203.0.113.9", start + 5_000)).toBe(true);

    // A full window after the last accepted request, the bucket is empty again.
    const afterWindow = start + 4_000 + guard.PUBLIC_FORM_RATE_LIMIT_WINDOW_MS;
    expect(guard.rateLimitPublicForm("leasing", "203.0.113.9", afterWindow)).toBe(false);
  });

  test("a refused request does not extend the window", () => {
    const start = 1_800_000_000_000;
    for (let i = 0; i < 5; i++) {
      guard.rateLimitPublicForm("contact", "198.51.100.8", start + i * 1_000);
    }
    // Five refusals, each a probe the limiter must record nothing for.
    for (let i = 5; i <= 9; i++) {
      expect(guard.rateLimitPublicForm("contact", "198.51.100.8", start + i * 1_000)).toBe(true);
    }

    // Exactly one window past the last ACCEPTED request. Had the refusals been
    // pushed, the five refusal timestamps would still be in-window here and
    // this probe would be refused; the window is measured from acceptance only.
    const afterWindow = start + 4_000 + guard.PUBLIC_FORM_RATE_LIMIT_WINDOW_MS;
    expect(guard.rateLimitPublicForm("contact", "198.51.100.8", afterWindow)).toBe(false);
  });
});
