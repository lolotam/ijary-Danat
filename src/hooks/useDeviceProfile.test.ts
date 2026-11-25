import { afterEach, describe, expect, it, vi } from "vitest";

import { readCanUseApplePay, readIsPhone } from "./useDeviceProfile";

/**
 * يركّب متصفحًا وهميًا بخصائص جهاز معيّن قبل تشغيل الفحص.
 *
 * The suite runs in Vitest's `node` environment, so there is no `window` to
 * spy on — the globals are installed outright. `screen` is what the probe reads
 * for size, deliberately not `innerWidth`, so only the device matters.
 */
function stubDevice(options: {
  applePaySession?: { canMakePayments?: () => boolean };
  coarsePointer: boolean;
  maxTouchPoints: number;
  screen: { height: number; width: number };
  withoutMatchMedia?: boolean;
}) {
  vi.stubGlobal("window", {
    ...(options.applePaySession ? { ApplePaySession: options.applePaySession } : {}),
    ...(options.withoutMatchMedia
      ? {}
      : { matchMedia: () => ({ matches: options.coarsePointer }) }),
    screen: options.screen,
  });
  vi.stubGlobal("navigator", { maxTouchPoints: options.maxTouchPoints });
}

/** آيفون 15 برو ماكس في سفاري: لمس، مؤشر خشن، وApple Pay متاح. */
const IPHONE = {
  coarsePointer: true,
  maxTouchPoints: 5,
  screen: { width: 430, height: 932 },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readCanUseApplePay", () => {
  it("is true when the browser reports it can open the sheet", () => {
    stubDevice({ ...IPHONE, applePaySession: { canMakePayments: () => true } });
    expect(readCanUseApplePay()).toBe(true);
  });

  it("is false when the browser has no ApplePaySession at all", () => {
    // An Android phone, and an iPhone inside a WhatsApp or email webview.
    stubDevice(IPHONE);
    expect(readCanUseApplePay()).toBe(false);
  });

  it("is false rather than throwing when canMakePayments raises", () => {
    // Apple Pay JS throws in an insecure or cross-origin-framed context. An
    // escaping exception here would take down the whole invoices route.
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubDevice({
      ...IPHONE,
      applePaySession: {
        canMakePayments: () => {
          throw new Error("InvalidAccessError");
        },
      },
    });
    expect(readCanUseApplePay()).toBe(false);
  });
});

describe("readIsPhone", () => {
  it("is true for a phone: coarse pointer, real touch, small screen", () => {
    stubDevice(IPHONE);
    expect(readIsPhone()).toBe(true);
  });

  it("is false for a desktop with a fine pointer", () => {
    stubDevice({ coarsePointer: false, maxTouchPoints: 0, screen: { width: 1920, height: 1080 } });
    expect(readIsPhone()).toBe(false);
  });

  it("is false for a touchscreen laptop driven by a mouse", () => {
    // The primary pointer is fine, so it keeps the QR — which is the only
    // Apple Pay path such a machine has.
    stubDevice({ coarsePointer: false, maxTouchPoints: 10, screen: { width: 1536, height: 864 } });
    expect(readIsPhone()).toBe(false);
  });

  it("is false for a full-size tablet, which can still display a QR", () => {
    stubDevice({ coarsePointer: true, maxTouchPoints: 5, screen: { width: 820, height: 1180 } });
    expect(readIsPhone()).toBe(false);
  });

  it("classifies a compact tablet as a phone — a known, accepted loss", () => {
    // An iPad mini reports a 744px short edge and loses the QR handoff. Pinned
    // rather than left to chance: the alternative threshold would start showing
    // an unscannable QR on an unfolded foldable, which is strictly worse.
    stubDevice({ coarsePointer: true, maxTouchPoints: 5, screen: { width: 744, height: 1133 } });
    expect(readIsPhone()).toBe(true);
  });

  it("is false rather than throwing when matchMedia is missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubDevice({ ...IPHONE, withoutMatchMedia: true });
    expect(readIsPhone()).toBe(false);
  });
});

describe("the two probes fail independently", () => {
  it("keeps the phone signal when the Apple Pay probe throws", () => {
    // The regression this pins. Both probes once shared a single try block, so
    // a throwing canMakePayments() — which happens in exactly the embedded
    // webviews this feature targets — also collapsed isPhone to false. The menu
    // then offered Apple Pay and the handoff resolved to show-qr: an unscannable
    // QR on the phone, which is the defect the feature exists to remove.
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubDevice({
      ...IPHONE,
      applePaySession: {
        canMakePayments: () => {
          throw new Error("InvalidAccessError");
        },
      },
    });

    expect(readCanUseApplePay()).toBe(false);
    expect(readIsPhone()).toBe(true);
  });
});
