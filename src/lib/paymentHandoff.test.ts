import { describe, expect, it } from "vitest";

import {
  enabledPaymentMethods,
  isPaymentMethodOffered,
  offeredPaymentMethods,
  paymentHandoffFor,
  type PaymentDeviceProfile,
} from "./paymentHandoff";

/** أجهزة نموذجية تغطي كل تركيبة من قدرات الدفع. */
const DEVICES = {
  // Windows / Linux / Android desktop: no Apple Pay sheet, but a phone is
  // plausibly nearby — this is the device class the QR exists for.
  desktopWithoutApplePay: { canUseApplePay: false, isPhone: false },
  // An iPad or Android tablet in a browser without Apple Pay JS. Coarse
  // pointer, but a large screen: still a usable QR display.
  tabletWithoutApplePay: { canUseApplePay: false, isPhone: false },
  macSafari: { canUseApplePay: true, isPhone: false },
  iphoneSafari: { canUseApplePay: true, isPhone: true },
  // Android phone, and iPhone opened from a WhatsApp or email in-app webview:
  // no Apple Pay sheet AND no second screen to scan with.
  phoneWithoutApplePay: { canUseApplePay: false, isPhone: true },
} as const satisfies Record<string, PaymentDeviceProfile>;

describe("paymentHandoffFor", () => {
  it("shows the QR on a desktop that cannot open the Apple Pay sheet", () => {
    expect(paymentHandoffFor({ method: "APPLE_PAY", device: DEVICES.desktopWithoutApplePay })).toBe(
      "show-qr",
    );
  });

  it("keeps the QR on a tablet, which can still display it for a nearby iPhone", () => {
    // The regression the size term guards: treating every coarse pointer as a
    // phone would strip the QR from an iPad.
    expect(paymentHandoffFor({ method: "APPLE_PAY", device: DEVICES.tabletWithoutApplePay })).toBe(
      "show-qr",
    );
  });

  it("opens Apple Pay in a new tab on a Mac that can open the sheet", () => {
    // macOS Safari is not a phone but must never see the QR.
    expect(paymentHandoffFor({ method: "APPLE_PAY", device: DEVICES.macSafari })).toBe("open-tab");
  });

  it("sends an iPhone straight to the hosted page in the same tab", () => {
    // Same-tab because iOS Safari blocks window.open once the user gesture has
    // been spent by the payment-request round trip.
    expect(paymentHandoffFor({ method: "APPLE_PAY", device: DEVICES.iphoneSafari })).toBe(
      "open-same-tab",
    );
  });

  it("reports Apple Pay unavailable on a phone that cannot open the sheet", () => {
    // Not "show-qr" — the phone would have to scan its own screen. Not
    // "open-same-tab" either: the hosted page would be a dead end, and the
    // caller must refuse before creating a payment request for it.
    expect(paymentHandoffFor({ method: "APPLE_PAY", device: DEVICES.phoneWithoutApplePay })).toBe(
      "unavailable",
    );
  });

  it("never shows a QR code on a phone, which cannot scan itself", () => {
    for (const device of [DEVICES.iphoneSafari, DEVICES.phoneWithoutApplePay]) {
      expect(paymentHandoffFor({ method: "APPLE_PAY", device })).not.toBe("show-qr");
    }
  });

  it.each(["KNET", "GOOGLE_PAY"] as const)("never hands %s to a phone, on any device", (method) => {
    // The original regression this guards: branching on canUseApplePay alone
    // would QR every KNET payment made from a Windows desktop.
    for (const device of Object.values(DEVICES)) {
      expect(paymentHandoffFor({ method, device })).not.toBe("show-qr");
      expect(paymentHandoffFor({ method, device })).not.toBe("unavailable");
    }
    expect(paymentHandoffFor({ method, device: DEVICES.desktopWithoutApplePay })).toBe("open-tab");
    expect(paymentHandoffFor({ method, device: DEVICES.iphoneSafari })).toBe("open-same-tab");
  });
});

describe("isPaymentMethodOffered", () => {
  it("hides Apple Pay only on a phone that cannot open the sheet", () => {
    expect(
      isPaymentMethodOffered({ method: "APPLE_PAY", device: DEVICES.phoneWithoutApplePay }),
    ).toBe(false);
  });

  it.each([
    ["desktopWithoutApplePay", DEVICES.desktopWithoutApplePay],
    ["tabletWithoutApplePay", DEVICES.tabletWithoutApplePay],
    ["macSafari", DEVICES.macSafari],
    ["iphoneSafari", DEVICES.iphoneSafari],
  ] as const)("offers Apple Pay on %s", (_name, device) => {
    expect(isPaymentMethodOffered({ method: "APPLE_PAY", device })).toBe(true);
  });

  it.each(["KNET", "GOOGLE_PAY"] as const)("always offers %s", (method) => {
    for (const device of Object.values(DEVICES)) {
      expect(isPaymentMethodOffered({ method, device })).toBe(true);
    }
  });

  it("agrees with paymentHandoffFor on every input", () => {
    // The two must not be able to disagree: an offered method whose handoff is
    // "unavailable" would be a button that refuses to do anything.
    for (const device of Object.values(DEVICES)) {
      for (const method of ["KNET", "GOOGLE_PAY", "APPLE_PAY"] as const) {
        expect(isPaymentMethodOffered({ method, device })).toBe(
          paymentHandoffFor({ method, device }) !== "unavailable",
        );
      }
    }
  });
});

describe("enabledPaymentMethods", () => {
  // Every combination the two switches can take. KNET leads all four, which is
  // the floor the rest of the feature relies on, and the extras follow in the
  // fixed order the tenant sees rather than the order they were enabled.
  it.each([
    ["neither extra", { applePay: false, googlePay: false }, ["KNET"]],
    ["google pay only", { applePay: false, googlePay: true }, ["KNET", "GOOGLE_PAY"]],
    ["apple pay only", { applePay: true, googlePay: false }, ["KNET", "APPLE_PAY"]],
    ["both extras", { applePay: true, googlePay: true }, ["KNET", "GOOGLE_PAY", "APPLE_PAY"]],
  ] as const)("returns KNET plus %s", (_name, settings, expected) => {
    expect(enabledPaymentMethods(settings)).toEqual(expected);
  });
});

describe("offeredPaymentMethods", () => {
  it("drops Apple Pay on a phone that cannot open the sheet", () => {
    expect(
      offeredPaymentMethods({
        device: DEVICES.phoneWithoutApplePay,
        enabled: enabledPaymentMethods({ applePay: true, googlePay: true }),
      }),
    ).toEqual(["KNET", "GOOGLE_PAY"]);
  });

  it("leaves KNET alone when the admin enabled Apple Pay and the device refuses it", () => {
    // The case a `configured.length === 1` branch gets wrong: two methods are
    // configured, but only one survives the device filter, so this must still
    // drive the single-method (no dropdown) rendering.
    expect(
      offeredPaymentMethods({
        device: DEVICES.phoneWithoutApplePay,
        enabled: enabledPaymentMethods({ applePay: true, googlePay: false }),
      }),
    ).toEqual(["KNET"]);
  });

  it("preserves the configured order rather than the device's", () => {
    expect(
      offeredPaymentMethods({
        device: DEVICES.macSafari,
        enabled: enabledPaymentMethods({ applePay: true, googlePay: true }),
      }),
    ).toEqual(["KNET", "GOOGLE_PAY", "APPLE_PAY"]);
  });

  it("never empties out, on any device and any settings", () => {
    // The invariant that removes the empty-menu state from the UI entirely.
    for (const device of Object.values(DEVICES)) {
      for (const applePay of [true, false]) {
        for (const googlePay of [true, false]) {
          const offered = offeredPaymentMethods({
            device,
            enabled: enabledPaymentMethods({ applePay, googlePay }),
          });
          expect(offered).toContain("KNET");
        }
      }
    }
  });
});
