# Portal mobile responsiveness & device-aware Apple Pay handoff — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the tenant portal showing an unscannable Apple Pay QR code on phones, send iPhones straight to the Apple Pay sheet, and fix six named mobile-layout defects on the portal screens.

**Architecture:** All Apple Pay decision logic stays in two pure functions in `src/lib/paymentHandoff.ts`, driven by a two-field device profile probed once on mount by a new `useDeviceProfile` hook. `portal.invoices.tsx` and `PayNowMenu.tsx` become thin consumers. The responsive work is a targeted class-level fix to six locations — the portal's responsive infrastructure (viewport meta, safe-area insets, `Table` overflow wrapper, mobile sidebar `Sheet`) is already correct and is not touched.

**Tech Stack:** TanStack Start (React 19), TypeScript, Tailwind CSS 4.2.4, shadcn/ui (Radix), Vitest, Bun.

Specs: `docs/superpowers/specs/2026-08-11-applepay-device-handoff-design.md`, `docs/superpowers/specs/2026-08-11-portal-mobile-responsive-design.md`.

## Global Constraints

- **Branch:** `feat/portal-mobile-and-applepay-handoff`. Never commit to `main`. Never force-push, rebase, amend or squash — the repo is Lovable-connected.
- **Arabic doc comments:** every function gets a doc comment **before** it, leading with an Arabic description of what it does. English follows only for the *why*. This is a hard project rule.
- **Logical properties only:** the portal is RTL-first (`dir="rtl"`). Use `ps-*`/`pe-*`/`ms-*`/`me-*`/`start`/`end`, never `pl-*`/`pr-*`/`left`/`right`. An LTR-only screenshot will not reveal a regression here.
- **No new i18n keys.** `src/i18n/dictionary.test.ts` fails the suite if a key exists in only one locale. Every change here is layout or logic, and the two mobile labels Task 6 adds reuse keys that already exist in both locales (`payments.amount`, `common.actions`). If a step seems to need *new* copy, the step is wrong.
- **Tasks 1–4 are a single commit.** Their intermediate states do not typecheck, and the project rule is that gates pass before committing. Tasks 5 onward commit individually.
- **Guards before presenting:** `clean-code-guard` on the production diff, `test-guard` on the test diff, `docs-guard` on the doc-comment changes.
- **File-size ceiling:** 500–600 lines. `portal.invoices.tsx` is 322 lines, `portal.payments.tsx` 212. Neither may cross 500.
- **Preserve `dark:` variants** on every element touched.
- **Exact MyFatoorah strings:** `"KNET"`, `"GOOGLE_PAY"`, `"APPLE_PAY"` — with underscores. `PayNowMenu.test.tsx:43-45` asserts these in source; a wrong spelling silently breaks the gateway.
- **No migration, no server function change, no env var, no `database.types.ts` change.** This is client-side only.
- **Gates before any commit is presented:** `bun run lint`, `bun run typecheck`, `bun run test`, `bun run format`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/paymentHandoff.ts` *(modify)* | The two pure decision functions and the `PaymentDeviceProfile` type. No React, no browser globals — the whole rule set, unit-testable. |
| `src/lib/paymentHandoff.test.ts` *(modify)* | Full truth table over method × device class. |
| `src/hooks/useDeviceProfile.ts` *(create)* | The only place that reads `window.ApplePaySession`, `matchMedia` and `navigator.maxTouchPoints`. Isolating it keeps `paymentHandoff.ts` pure. |
| `src/components/portal/PayNowMenu.tsx` *(modify)* | Renders the offered subset of methods. Owns the display order. |
| `src/components/portal/PayNowMenu.test.tsx` *(modify)* | Asserts an unoffered method does not render. |
| `src/routes/portal.invoices.tsx` *(modify)* | Wires the hook to the functions; three-way branch in `paySelected`; invoice-row mobile layout. |
| `src/routes/portal.payments.tsx` *(modify)* | Payment-row mobile layout. |
| `src/routes/portal.tsx` *(modify)* | Header touch targets; nav tab wrapping and touch targets. |
| `src/routes/portal.index.tsx` *(modify)* | Hero statistics grid breakpoint. |
| `src/components/portal/PayNowMenu.methods.test.tsx` *(create)* | Behavioural test of the filtered method list, with the Radix primitives mocked so a static render can see them. |
| `src/components/portal/AnnouncementBanner.tsx` *(modify)* | Yields before the brand mark at the narrowest width. |
| `src/routes/portal_.payments.callback.tsx` *(modify)* | Now a primary phone screen: safe-area insets, `min-h-dvh`, 44px controls. |
| `src/routes/portal_.auth.tsx` *(modify)* | Two undersized controls. |
| `src/components/portal/TenantMessageForm.tsx` *(modify)* | Undersized inputs and submit button. |
| `src/components/ThemeToggle.tsx` *(modify)* | Shared with admin — 40px stays on a fine pointer, 44px on a coarse one. |

---

## Task 1: The device profile and the two decision functions

**Files:**
- Modify: `src/lib/paymentHandoff.ts` (whole file)
- Test: `src/lib/paymentHandoff.test.ts` (whole file)

**Interfaces:**
- Consumes: `HostedPaymentMethod` from `@/fns/createPayment` (type-only import — it is already imported that way; do **not** import the module's *values*, it is a server-function module and pulling its runtime into the client bundle is a regression).
- Produces:
  - `export interface PaymentDeviceProfile { canUseApplePay: boolean; isPhone: boolean }`
  - `export type PaymentHandoff = "open-tab" | "open-same-tab" | "show-qr" | "unavailable"`
  - `export function paymentHandoffFor(input: { device: PaymentDeviceProfile; method: HostedPaymentMethod }): PaymentHandoff`
  - `export function isPaymentMethodOffered(input: { device: PaymentDeviceProfile; method: HostedPaymentMethod }): boolean`

**Two decisions carried over from the Codex design review — do not "simplify" them back:**

- The field is `isPhone`, not `isHandheld`, and it includes a **size** term. A tablet is a perfectly good QR display for a nearby iPhone, so hiding Apple Pay from every coarse-pointer device would strip the QR from an iPad. Only a phone genuinely cannot scan its own screen.
- `isPaymentMethodOffered` is **derived from** `paymentHandoffFor` rather than repeating the condition. Two independent copies of the same rule can disagree; a derived one cannot.

- [ ] **Step 1: Rewrite the test file with the full truth table**

Replace the entire contents of `src/lib/paymentHandoff.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  isPaymentMethodOffered,
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run test -- src/lib/paymentHandoff.test.ts`
Expected: FAIL — `isPaymentMethodOffered` is not exported, and `paymentHandoffFor` does not accept a `device` argument.

- [ ] **Step 3: Rewrite `src/lib/paymentHandoff.ts`**

Replace the entire file:

```ts
import type { HostedPaymentMethod } from "@/fns/createPayment";

/**
 * ما الذي يستطيع جهاز المستأجر فعله بشأن الدفع.
 *
 * Two independent questions, deliberately kept apart: whether *this browser*
 * can open the Apple Pay sheet, and whether this is a phone. Collapsing them
 * into one boolean is what produced the QR-code-on-a-phone defect.
 */
export interface PaymentDeviceProfile {
  /** `window.ApplePaySession?.canMakePayments?.() === true` */
  canUseApplePay: boolean;
  /**
   * هاتف: مؤشر خشن، ولمس حقيقي، وشاشة صغيرة.
   *
   * The size term is load-bearing. A tablet has a coarse pointer too, but it is
   * a perfectly good QR display for a nearby iPhone — only a phone cannot scan
   * its own screen.
   */
  isPhone: boolean;
}

/**
 * ما الذي يُفعل برابط الدفع، أو أن الوسيلة غير متاحة على هذا الجهاز أصلًا.
 */
export type PaymentHandoff = "open-tab" | "open-same-tab" | "show-qr" | "unavailable";

/**
 * يقرر مصير الدفع بهذه الوسيلة على هذا الجهاز.
 *
 * `unavailable` is returned rather than a best-effort redirect so the caller can
 * refuse *before* creating a payment request. Sending a phone to a hosted Apple
 * Pay page it cannot use would leave an orphan payment request behind and show
 * the tenant a dead page.
 *
 * `show-qr` is reachable only on a non-phone, because a phone would have to scan
 * its own screen — that is the defect this function was rewritten to fix. It is
 * also guarded on APPLE_PAY: KNET and Google Pay run in any browser, and QR-ing
 * them would add a step for no reason.
 *
 * `open-same-tab` exists because iOS Safari only honours `window.open` inside a
 * live user-gesture stack, and the gesture is spent by the time the
 * payment-request round trip resolves. Same-tab is safe: the Supabase session
 * lives in storage rather than in the tab, and `/portal/payments/callback` sits
 * outside the portal's auth guard and waits for the session to restore.
 */
export function paymentHandoffFor(input: {
  device: PaymentDeviceProfile;
  method: HostedPaymentMethod;
}): PaymentHandoff {
  const { canUseApplePay, isPhone } = input.device;
  if (input.method === "APPLE_PAY" && !canUseApplePay) {
    return isPhone ? "unavailable" : "show-qr";
  }
  return isPhone ? "open-same-tab" : "open-tab";
}

/**
 * يقرر ما إذا كانت وسيلة الدفع تُعرض أصلًا على هذا الجهاز.
 *
 * Derived from `paymentHandoffFor` rather than repeating its condition: two
 * copies of one rule can drift apart, and the failure that produces — an
 * offered method whose handoff is `unavailable` — is a button that silently
 * does nothing.
 */
export function isPaymentMethodOffered(input: {
  device: PaymentDeviceProfile;
  method: HostedPaymentMethod;
}): boolean {
  return paymentHandoffFor(input) !== "unavailable";
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run test -- src/lib/paymentHandoff.test.ts`
Expected: PASS, all cases.

**Do not commit yet.** `portal.invoices.tsx` still calls the old signature, so `bun run typecheck` fails until Task 4. Committing a red typecheck violates the project gate rule. Tasks 1–4 are one commit, taken at the end of Task 4.

---

## Task 2: The device probe hook

**Files:**
- Create: `src/hooks/useDeviceProfile.ts`

**Interfaces:**
- Consumes: `PaymentDeviceProfile` from `@/lib/paymentHandoff` (Task 1).
- Produces: `export function useDeviceProfile(): PaymentDeviceProfile`

There is no unit test for this hook. It is a guarded read of three browser globals with no branching; a Vitest test would assert a `matchMedia` mock rather than the behaviour. Its correctness is established by the device matrix in Task 8.

- [ ] **Step 1: Create the hook**

```ts
import { useEffect, useState } from "react";

import type { PaymentDeviceProfile } from "@/lib/paymentHandoff";

declare global {
  interface Window {
    // Safari-only, and absent from the DOM lib. `canMakePayments` answers "can
    // this browser open the Apple Pay sheet" — which is the question. Sniffing
    // the user agent is not: iPad Safari reports a desktop-class UA.
    ApplePaySession?: { canMakePayments?: () => boolean };
  }
}

/**
 * أطول ضلع للشاشة يُعتبر بعده الجهاز هاتفًا لا لوحًا.
 *
 * Compared against the shorter edge of `window.screen`, not the viewport.
 * Orientation then does not change the answer — an iPhone in landscape is 932px
 * wide but 430px tall — and neither does iPad split view or an in-app webview's
 * chrome, both of which shrink `innerWidth`/`innerHeight` enough to make a
 * tablet look like a phone. `screen` reports the device, which is the question.
 *
 * A small laptop (1280×720) falls under this threshold too, and is excluded by
 * the pointer and touch terms rather than by size.
 */
const PHONE_MAX_EDGE_PX = 768;

/**
 * الحالة قبل الفحص، وعند فشله: حاسوب مكتبي.
 *
 * The safe direction. A desktop profile yields the QR, which is a working path
 * on every device; guessing "phone" would hide Apple Pay from a Mac.
 */
const DESKTOP_PROFILE: PaymentDeviceProfile = { canUseApplePay: false, isPhone: false };

/**
 * يقرأ قدرات الجهاز من متصفحه، ويعود إلى حالة الحاسوب المكتبي عند أي فشل.
 *
 * `ApplePaySession.canMakePayments()` throws in an insecure or cross-origin
 * framed context, and `matchMedia` is missing from some embedded webviews.
 * Either throw *is* an answer — this browser cannot open the sheet — so the
 * desktop profile is returned rather than letting the exception escape and take
 * down the invoices route.
 */
function readDeviceProfile(): PaymentDeviceProfile {
  try {
    return {
      canUseApplePay: window.ApplePaySession?.canMakePayments?.() === true,
      isPhone:
        window.matchMedia("(pointer: coarse)").matches &&
        navigator.maxTouchPoints > 0 &&
        Math.min(window.screen.width, window.screen.height) < PHONE_MAX_EDGE_PX,
    };
  } catch (error) {
    console.error("Reading device payment capabilities failed; assuming desktop.", error);
    return DESKTOP_PROFILE;
  }
}

/**
 * يفحص قدرات الجهاز المتعلقة بالدفع مرة واحدة بعد التركيب.
 *
 * Resolved in an effect rather than during render: `/portal` is `ssr: false`
 * today, but reading `window` while rendering is a hydration hazard that a
 * future route-config change could silently reintroduce. There is no
 * flash-of-wrong-methods to guard against — Radix mounts `DropdownMenuContent`
 * only when the menu is opened, which is always after this effect has run.
 *
 * `isPhone` tests the *primary* pointer plus the screen's shorter edge, not the
 * viewport width alone and not the user agent. Width alone would strip the QR
 * from a desktop user who merely narrows their window — the only Apple Pay path
 * they have. `(any-pointer: coarse)` would be wrong in the other direction: it
 * is true for a touchscreen laptop driven by a mouse.
 */
export function useDeviceProfile(): PaymentDeviceProfile {
  const [profile, setProfile] = useState<PaymentDeviceProfile>(DESKTOP_PROFILE);

  useEffect(() => {
    setProfile(readDeviceProfile());
  }, []);

  return profile;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: still only the pre-existing `portal.invoices.tsx` error from Task 1, and no new errors. In particular, no "Duplicate identifier" — `portal.invoices.tsx` still carries its own `declare global` block for `ApplePaySession`; identical `declare global` interface merges are legal, and Task 4 removes the duplicate.

**Do not commit yet** — see the note at the end of Task 1.

---

## Task 3: `PayNowMenu` renders only the offered methods

**Files:**
- Modify: `src/components/portal/PayNowMenu.tsx`
- Test: `src/components/portal/PayNowMenu.test.tsx`

**Interfaces:**
- Consumes: `isPaymentMethodOffered`, `PaymentDeviceProfile` from `@/lib/paymentHandoff` (Task 1).
- Produces: `PayNowMenu` gains a required prop `device: PaymentDeviceProfile`. Its other props (`disabled`, `pendingMethod`, `onSelect`) are unchanged.

The component takes the profile and filters, rather than a pre-filtered array, so the display order stays in the module constant beside the exact MyFatoorah strings that the existing test asserts in source.

- [ ] **Step 1: Add a real behavioural test**

Radix portals `DropdownMenuContent`, so the method list never reaches `renderToStaticMarkup`. The fix is to mock the dropdown primitives with plain inline elements for this one test file — this keeps the existing `environment: "node"` config in `vitest.config.ts` and needs no jsdom. Do **not** assert a regex against the component's source: that pins formatting, survives dead code, and breaks on a harmless refactor.

Create `src/components/portal/PayNowMenu.methods.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// Radix portals the menu content out of the rendered tree, so a static render
// never sees the items. Replacing the primitives with plain elements is what
// makes the filtered list assertable without adding jsdom to the whole suite.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { PayNowMenu } from "@/components/portal/PayNowMenu";

/**
 * يرسم القائمة بملف جهاز معيّن ويعيد الشيفرة الناتجة.
 */
function markupFor(device: { canUseApplePay: boolean; isPhone: boolean }) {
  return renderToStaticMarkup(
    <PayNowMenu device={device} disabled={false} pendingMethod={null} onSelect={vi.fn()} />,
  );
}

describe("PayNowMenu method filtering", () => {
  it("omits Apple Pay on a phone that cannot open the sheet", () => {
    const markup = markupFor({ canUseApplePay: false, isPhone: true });
    expect(markup).toContain("portal.paymentMethod.knet");
    expect(markup).toContain("portal.paymentMethod.googlepay");
    expect(markup).not.toContain("portal.paymentMethod.applepay");
  });

  it.each([
    ["a desktop without Apple Pay", { canUseApplePay: false, isPhone: false }],
    ["an iPhone in Safari", { canUseApplePay: true, isPhone: true }],
    ["a Mac with Apple Pay", { canUseApplePay: true, isPhone: false }],
  ] as const)("offers all three methods on %s", (_name, device) => {
    const markup = markupFor(device);
    expect(markup).toContain("portal.paymentMethod.knet");
    expect(markup).toContain("portal.paymentMethod.googlepay");
    expect(markup).toContain("portal.paymentMethod.applepay");
  });

  it("keeps the declared order: KNET, then Google Pay, then Apple Pay", () => {
    const markup = markupFor({ canUseApplePay: true, isPhone: false });
    expect(markup.indexOf("portal.paymentMethod.knet")).toBeLessThan(
      markup.indexOf("portal.paymentMethod.googlepay"),
    );
    expect(markup.indexOf("portal.paymentMethod.googlepay")).toBeLessThan(
      markup.indexOf("portal.paymentMethod.applepay"),
    );
  });
});
```

In the **existing** `src/components/portal/PayNowMenu.test.tsx`, add `device={{ canUseApplePay: false, isPhone: false }}` to each of the three `renderToStaticMarkup` calls so they still compile. Add no new assertions there — its job is the closed-state contract and the exact gateway strings, and both still hold.

- [ ] **Step 2: Run the tests and confirm the new file fails**

Run: `bun run test -- src/components/portal/`
Expected: the new `PayNowMenu.methods.test.tsx` FAILS (`device` is not a known prop and all three methods render regardless); the existing file compiles once the prop is added.

- [ ] **Step 3: Update the component**

In `src/components/portal/PayNowMenu.tsx`, add to the imports:

```ts
import { isPaymentMethodOffered, type PaymentDeviceProfile } from "@/lib/paymentHandoff";
```

Amend the doc comment above `paymentMethodButtons` — it currently claims "Apple Pay is listed on every device", which is no longer true. Replace that sentence with:

```
 * Apple Pay is filtered out on a phone that cannot open the sheet: a QR code is
 * useless on the device that would have to scan it, and the hosted page would
 * be a dead end. A tablet keeps it — it can still display the QR for a nearby
 * iPhone.
```

Change the signature:

```tsx
export function PayNowMenu({
  device,
  disabled,
  pendingMethod,
  onSelect,
}: {
  device: PaymentDeviceProfile;
  disabled: boolean;
  pendingMethod: HostedPaymentMethod | null;
  onSelect: (method: HostedPaymentMethod) => void;
}) {
```

and inside `DropdownMenuContent`:

```tsx
        {paymentMethodButtons
          .filter(({ method }) => isPaymentMethodOffered({ device, method }))
          .map(({ method, icon: Icon, labelKey }) => (
```

Everything else in the component is unchanged.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun run test -- src/components/portal/`
Expected: PASS, both files, including the three pre-existing tests.

**Do not commit yet** — see the note at the end of Task 1.

---

## Task 4: Wire the invoices page, and fix the popup detection

**Files:**
- Modify: `src/routes/portal.invoices.tsx` — lines 22-30 (`declare global`), 47 and 58-60 (state and probe), 150-184 (`paySelected`), 304-308 (`PayNowMenu` usage)

**Interfaces:**
- Consumes: `useDeviceProfile` (Task 2), `paymentHandoffFor` (Task 1), `PayNowMenu`'s new `device` prop (Task 3).
- Produces: nothing consumed by later tasks.

**A suspected pre-existing bug this task does NOT fix — deliberately.** Line 170 reads:

```ts
const opened = window.open(result.paymentUrl, "_blank", "noopener,noreferrer");
if (!opened) { /* treated as "popup blocked" */ }
```

The HTML standard says `window.open` returns `null` whenever `noopener` is set, even on success — which would mean this fires a false "popup blocked" toast on *every* desktop payment. The Codex review raised it and the reading looks right, but it **could not be verified in a browser** during planning, and nobody has reported the symptom in production.

So the desktop branch is left **exactly as it is**. Do not rewrite it. The alternative — pre-opening a blank tab inside the click and navigating it later — was designed and then rejected, because it cannot keep the `noopener` protection: `gatewayTab.opener = null` does not survive the cross-origin navigation that follows, so it would trade a real security property for a fix to an unconfirmed bug.

Task 9's device matrix adds a row that settles it empirically. If a successful desktop KNET payment does show the toast, file it as its own change with its own decision about the opener trade-off.

- [ ] **Step 1: Remove the duplicated global declaration**

Delete lines 22-30 entirely — the `declare global { interface Window { ApplePaySession … } }` block. It now lives in `src/hooks/useDeviceProfile.ts`, the only file that reads it.

- [ ] **Step 2: Replace the state and probe with the hook**

Add to the imports:

```ts
import { useDeviceProfile } from "@/hooks/useDeviceProfile";
```

Delete line 47 (`const [canUseApplePay, setCanUseApplePay] = useState(false);`) and the entire `useEffect` at lines 53-60 including its comment block. In their place, beside the other hook calls near the top of the component:

```ts
const device = useDeviceProfile();
```

- [ ] **Step 3: Rewrite `paySelected`**

Replace the whole function body:

```ts
  /**
   * يبدأ طلب دفع للفاتورات المحددة عبر الوسيلة المختارة.
   *
   * The handoff is decided *before* the request so an unusable rail never
   * creates an orphan payment request that no one will ever pay.
   */
  async function paySelected(paymentMethod: HostedPaymentMethod) {
    if (!selectedIds.length) return;
    const handoff = paymentHandoffFor({ method: paymentMethod, device });
    // Not offered on this device — PayNowMenu already hides it, so reaching
    // here means a direct call. Refuse rather than create a payment request
    // for a page the tenant cannot pay on.
    if (handoff === "unavailable") return;

    setPendingMethod(paymentMethod);
    try {
      const result = await createPayment.mutateAsync({
        invoiceIds: selectedIds,
        paymentMethod,
        ...(contractId ? { contractId } : {}),
      });

      // A desktop that cannot open the Apple Pay sheet: hand the payment to the
      // tenant's phone rather than opening a page with a dead button.
      if (handoff === "show-qr") {
        setApplePayHandoff({
          paymentUrl: result.paymentUrl,
          paymentRequestCode: result.paymentRequestCode,
        });
        return;
      }

      // On a phone, navigate rather than open: iOS Safari has already spent the
      // user gesture on the request above.
      if (handoff === "open-same-tab") {
        window.location.assign(result.paymentUrl);
        return;
      }

      // Desktop: a new tab keeps the portal visible behind the gateway. This
      // branch is carried over unchanged — see the note above this task before
      // touching the popup-blocked check.
      const opened = window.open(result.paymentUrl, "_blank", "noopener,noreferrer");
      if (!opened) {
        toast.error(t("common.popupBlocked"), {
          action: {
            label: t("portal.invoices.payNow"),
            onClick: () => window.open(result.paymentUrl, "_blank", "noopener,noreferrer"),
          },
        });
      }
    } catch (error) {
      console.error("Failed to create a portal payment request.", error);
    } finally {
      setPendingMethod(null);
    }
  }
```

- [ ] **Step 4: Pass the profile to the menu**

```tsx
          <PayNowMenu
            device={device}
            disabled={!selectedIds.length}
            pendingMethod={pendingMethod}
            onSelect={(method) => void paySelected(method)}
          />
```

- [ ] **Step 5: Check for a now-dead import by hand**

Run: `grep -c "useState" src/routes/portal.invoices.tsx`
Expected: non-zero — `selectedIds`, `pendingMethod`, `applePayHandoff` and `invoiceContractCode` all still use it. `bun run lint` will **not** catch a dead import: `no-unused-vars` is disabled in this repo's ESLint config.

- [ ] **Step 6: Add the missing Arabic doc comment**

`CLAUDE.md` requires an Arabic-first doc comment above **every** function, not only new ones, and `PortalInvoicesPage` is a function this task modifies. Add one above it if absent.

- [ ] **Step 7: Run the full gates — they must all be green now**

Run: `bun run lint && bun run typecheck && bun run test && bun run format`
Expected: all PASS. The typecheck error carried since Task 1 is resolved here. Paste the real output.

- [ ] **Step 8: Commit Tasks 1–4 together**

One commit, because the intermediate states do not typecheck and the project rule is that gates pass before committing.

```bash
git add src/lib/paymentHandoff.ts src/lib/paymentHandoff.test.ts \
        src/hooks/useDeviceProfile.ts \
        src/components/portal/PayNowMenu.tsx \
        src/components/portal/PayNowMenu.test.tsx \
        src/components/portal/PayNowMenu.methods.test.tsx \
        src/routes/portal.invoices.tsx
git commit -m "fix(portal): send phones to Apple Pay instead of an unscannable QR"
```

---


## Task 5: Invoice rows read as one card on a phone

**Files:**
- Modify: `src/routes/portal.invoices.tsx` — the invoice row container and its four children

Spec defect 1. The row is `grid gap-4 … sm:grid-cols-[auto_auto_1fr_auto]` with **no mobile column count**, so Tailwind's one-column default applies below 640px and each child becomes its own full-width row: number badge, then checkbox, then details, then amount. The checkbox ends up stranded on a line away from what it selects.

Target mobile layout — row 1: `[badge] [checkbox] …………… [amount]`; row 2: the details block spanning all three columns.

- [ ] **Step 1: Give the container mobile columns**

Change the row container's `className` first argument in the `cn(...)` call from:

```
"grid gap-4 bg-card p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 sm:grid-cols-[auto_auto_1fr_auto] sm:items-center"
```

to:

```
"grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-2 bg-card p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 sm:grid-cols-[auto_auto_1fr_auto] sm:gap-4"
```

The `invoice.is_overdue` and `!enabled` entries in the same `cn(...)` call are unchanged.

- [ ] **Step 2: Place the details block on its own row below**

On the `<div className="min-w-0">` that wraps the period, contract code, amounts and lock reason, change the class to:

```
"col-span-3 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto"
```

- [ ] **Step 3: Move the amount to the end of the first row**

Change the amount wrapper from:

```
"flex items-center justify-between gap-3 sm:flex-col sm:items-end"
```

to:

```
"col-start-3 row-start-1 flex items-center justify-end gap-3 sm:col-start-auto sm:row-start-auto sm:flex-col sm:items-end"
```

`justify-end`, `col-start-3` and `row-start-*` are all direction-aware in a grid, so this mirrors correctly under `dir="rtl"` with no RTL-specific class. `justify-between` is dropped because the wrapper has a single child.

- [ ] **Step 4: Verify in the browser at 360px**

Run `bun run dev`, open `/portal/invoices` at a 360px viewport in both `ar` and `en`.
Expected: each invoice is two lines — badge, checkbox and amount on the first; period, contract code, amounts and any lock reason on the second. No horizontal page scroll. The checkbox is still at least 44×44px (it keeps its `min-h-11 min-w-11`).

- [ ] **Step 5: Run the gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run format
git add src/routes/portal.invoices.tsx
git commit -m "fix(portal): lay invoice rows out as one card per invoice on phones"
```

---

## Task 6: Payment rows become a labelled two-column card on a phone

**Files:**
- Modify: `src/routes/portal.payments.tsx:110` (row container), `:141` and `:145` (amount block)

Spec defect 2. Same missing mobile column count as Task 5, one child worse — six stacked rows per payment. Separately, six columns is too dense for the 640px `sm` breakpoint it currently activates at; reference, date, period and method collide on a small tablet.

- [ ] **Step 1: Give the container mobile columns and move the six-column grid to `lg:`**

Change line 110's `className` from:

```
"grid gap-4 bg-card p-5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 sm:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] sm:items-center"
```

to:

```
"grid grid-cols-2 gap-x-4 gap-y-3 bg-card p-5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 lg:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] lg:items-center lg:gap-4"
```

Below `lg` the six children pair up into three labelled rows — code/date, period/method, amount/actions — which is the two-column card the spec calls for. Each child already carries its own `text-xs` label, so no new copy is needed.

- [ ] **Step 2: Move the amount block's alignment to the same breakpoint**

Line 141: change `"sm:text-end"` to `"lg:text-end"`.
Line 145: change `"mt-2 flex sm:justify-end"` to `"mt-2 flex lg:justify-end"`.

- [ ] **Step 3: Label the amount and actions cells on mobile**

Four of the six children already carry an `text-xs text-muted-foreground` label. The amount cell (line ~141) and the actions cell do not — on desktop the column position says what they are, but in a two-column mobile card they are unlabelled. Both labels exist in the dictionary already, in **both** locales, so this adds no i18n keys: `payments.amount` (`dictionary.ts:932` / `:2581`) and `common.actions` (`:252` / `:1887`).

Add above the amount value, inside the amount cell:

```tsx
                  <p className="text-xs text-muted-foreground lg:hidden">{t("payments.amount")}</p>
```

Wrap the actions child so it can carry a label below `lg`:

```tsx
                <div className="lg:contents">
                  <p className="text-xs text-muted-foreground lg:hidden">{t("common.actions")}</p>
                  {/* Receipt actions stay transaction-wide: a receipt documents the
                    payment that was actually made, not one contract's slice of it. */}
                  <PaymentRowActions payment={payment} company={company.data ?? null} />
                </div>
```

`lg:contents` is what keeps the desktop row byte-identical: at `lg` the wrapper stops generating a box, the label is `hidden`, and `PaymentRowActions` becomes the sixth grid child again exactly as it is today. Without it the wrapper would become the grid cell and `PaymentRowActions`'s `justify-end` would align inside the wrapper rather than inside the cell.

`PaymentRowActions` itself needs no change: its root is `flex items-center justify-end gap-1` (`PaymentRowActions.tsx:111`), which already sits at the inline-end of whatever cell it lands in and carries no breakpoint.

- [ ] **Step 4: Verify in the browser**

Open `/portal/payments` at 360px, 768px and 1280px, in both `ar` and `en`.
Expected: two labelled columns on the phone; still two columns at 768px; the six-column row returns at 1024px and above. No horizontal page scroll at any width. The payment code, which is `break-all`, wraps rather than overflowing.

- [ ] **Step 5: Run the gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run format
git add src/routes/portal.payments.tsx
git commit -m "fix(portal): show payments as a two-column card below the lg breakpoint"
```

---

## Task 7: Portal header and nav reach the 44px touch minimum

**Files:**
- Modify: `src/routes/portal.tsx:289-307` (header controls), `:309-333` (nav strip)
- Modify: `src/components/ThemeToggle.tsx:13` (button size)

Spec defects 3 and 4. Header controls are `size="sm"` (≈32–36px) and nav tabs are `px-3 py-2 text-xs` (≈32px), both under the 44×44px minimum. The nav strip is `overflow-x-auto` with up to six tabs and no indication that content continues past the edge.

Use Tailwind 4's `pointer-coarse:` variant so the enlargement applies on touch devices at any width, rather than to a narrow desktop window. This is the same signal `useDeviceProfile` probes, which keeps the CSS and the payment logic consistent. Tailwind 4.2.4 is installed and supports it.

- [ ] **Step 1: Enlarge the header controls**

On the language `Button` (line ~291) and the sign-out `Button` (line ~294), add `pointer-coarse:min-h-11 pointer-coarse:min-w-11` to each `className`. The sign-out button has no `className` today — add `className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"`. Keep `size="sm"` and every existing prop.

- [ ] **Step 2: Enlarge the theme toggle**

`ThemeToggle` is a fixed `size-10` (40px) with no `className` prop, and is shared with the admin layout and the auth screens. Change `size-10` to `size-10 pointer-coarse:size-11` in its `className` at `src/components/ThemeToggle.tsx:13`. Adding the prop plumbing instead would touch every call site for a two-character difference.

- [ ] **Step 3: Let the nav tabs wrap instead of scrolling**

On the `<nav>` at line ~310, change:

```
"mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-3"
```

to:

```
"mx-auto flex max-w-7xl flex-wrap gap-1 px-4 pb-3"
```

Wrapping is chosen over an edge-fade affordance because it removes the hidden content rather than hinting at it, and it needs no direction-sensitive gradient under RTL. On desktop there is room for all six tabs, so nothing wraps and the appearance is unchanged.

- [ ] **Step 4: Enlarge the tabs**

On the tab `Link` (line ~321), change:

```
"flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-xs font-medium …"
```

to:

```
"flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-xs font-medium pointer-coarse:min-h-11 pointer-coarse:px-4 …"
```

Leave the rest of the class string, `activeProps` and `activeOptions` exactly as they are.

- [ ] **Step 5: Make the announcement banner yield before the brand mark**

The spec calls for an explicit shrink order, and nothing in the steps above delivers it. Today the brand `Link` at `portal.tsx:282` is `min-w-0` (freely shrinkable), `AnnouncementBanner`'s root is `min-w-0 flex-1` (`AnnouncementBanner.tsx:34`, so it *takes* the slack), and only the controls are `shrink-0` (`portal.tsx:289`). At 360px with a long Arabic announcement the brand is what collapses.

Two changes:

- On the brand `Link` (`portal.tsx:282`), change `className="min-w-0"` to `className="min-w-0 shrink-0"` so it holds its intrinsic width.
- On the `AnnouncementBanner` root (`AnnouncementBanner.tsx:34`), add `hidden sm:block` before the existing classes so the marquee is absent entirely on the narrowest screens, where there is no room for it beside the logo and three controls.

Verify with a long Arabic announcement at 360px: the brand name and tenant sub-name must both remain legible.

- [ ] **Step 6: Confirm the variant actually compiled**

A silently-unrecognised variant would produce no CSS and no error. With the dev server running:

Run: `bun run build` then `grep -rc "pointer: coarse" dist/ .output/ 2>/dev/null | grep -v ":0"`
Expected: at least one built stylesheet contains a `@media (pointer: coarse)` block. If nothing matches, the variant did not resolve — replace every `pointer-coarse:X` with a plain `X` (accepting the larger target on desktop too) and note it in the PR.

- [ ] **Step 7: Verify in the browser**

Open the portal at 360px in `ar` and `en`, with device emulation on so the pointer is coarse.
Expected: theme, language and sign-out controls are ≥44px; tabs are ≥44px tall and wrap to a second line rather than scrolling out of view; the brand logo is not crushed by the announcement marquee. Check the admin layout at desktop width too — `ThemeToggle` is shared, and a fine pointer must leave it at 40px.

- [ ] **Step 8: Run the gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run format
git add src/routes/portal.tsx src/components/ThemeToggle.tsx src/components/portal/AnnouncementBanner.tsx
git commit -m "fix(portal): give header and nav controls a 44px touch target"
```

---

## Task 8: The same-tab destination screens and the remaining touch targets

**Files:**
- Modify: `src/routes/portal_.payments.callback.tsx`
- Modify: `src/routes/portal_.auth.tsx:104-115` and `:224-227`
- Modify: `src/components/portal/TenantMessageForm.tsx`

Added after the Codex design review. Tasks 1–4 make `/portal/payments/callback` a **primary phone screen** — before this change a phone only reached it by scanning a QR, and now every phone payment lands there in the same tab. It has no responsive task in the original plan, and neither do two other screens whose controls fail the plan's own 44px rule. A verification checkbox is not enough when the fix is known in advance.

- [ ] **Step 1: Give the callback screen phone treatment**

The callback route sits deliberately outside the `/portal` layout (`portal_.payments.callback.tsx:57-59`), so it inherits none of the layout's safe-area or spacing work.

- Replace every `min-h-screen` in this file with `min-h-dvh`. On mobile Safari `100vh` is the *unshrunk* viewport, so a `min-h-screen` centred layout sits partly under the browser chrome.
- Add `pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]` to the outermost wrapper, matching `portal.tsx:280`.
- Add `pointer-coarse:min-h-11` to every `Button` on this screen (the result-state actions around lines 134-205), and confirm the `dir` attribute is applied so the Arabic layout mirrors.

- [ ] **Step 2: Fix the two undersized controls on the sign-in screen**

In `src/routes/portal_.auth.tsx`:

- The language toggle at `:111` is `min-h-10`. Change to `min-h-10 pointer-coarse:min-h-11`.
- The "back home" link at `:224-227` is a bare text link with no target size. Add `inline-flex min-h-11 items-center` to its `className`.

- [ ] **Step 3: Fix the message form controls**

`TenantMessageForm` is mounted on the portal dashboard (`portal.index.tsx:138-140`). Its inputs inherit `h-9` from `src/components/ui/input.tsx` and its submit button the default `min-h-10`.

- Add `pointer-coarse:min-h-11` to the form's `Input`/`Textarea` and to the submit `Button` (`TenantMessageForm.tsx:43-79`).
- Do **not** change `src/components/ui/input.tsx` itself — it is shared with every admin form, and this plan's scope is the portal.

- [ ] **Step 4: Add an Arabic doc comment to each function this task modifies**

`CLAUDE.md` requires an Arabic-first doc comment above **every** function, not only new ones. Add one where absent to `PaymentCallbackPage`, the auth page component, and `TenantMessageForm`.

- [ ] **Step 5: Verify**

Open `/portal/payments/callback?preq=test` and `/portal/auth` at 360px in `ar` and `en`, with a coarse pointer emulated.
Expected: no content under the notch or home indicator, no horizontal scroll, every button and link at least 44px tall, RTL mirroring intact.

- [ ] **Step 6: Run the gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run format
git add src/routes/portal_.payments.callback.tsx src/routes/portal_.auth.tsx \
        src/components/portal/TenantMessageForm.tsx
git commit -m "fix(portal): give the callback, sign-in and message form phone treatment"
```

---

## Task 9: Hero statistics step to `md`, then full verification

**Files:**
- Modify: `src/routes/portal.index.tsx:71`

Spec defect 5. Three currency values across a 640px viewport inside a card that already carries `p-6`; the longest Arabic label with a five-figure amount does not fit. The other two grids on this page (`:33` and `:114`) are already `md:grid-cols-3` and are correct — this change makes line 71 match them.

- [ ] **Step 1: Change the breakpoint**

On line 71, change `sm:grid-cols-3` to `md:grid-cols-3`. The rest of the class string is unchanged.

- [ ] **Step 2: Confirm the verify-only screens need no change**

Read `src/routes/portal.lease.tsx:118` and `src/routes/portal.profile.tsx:116`. Both should read `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`. View both at 360px in `ar`.
Expected: single column, no truncation, no horizontal scroll — **no code change**. If either does overflow, fix it and say so in the PR; the spec recorded them as examined rather than missed.

- [ ] **Step 3: Apple Pay device matrix**

Unit tests prove the rules but cannot prove the probe reads what we think it reads. On the deployed branch, confirm each row — and record which rows were actually exercised rather than assumed:

| Device | Expected |
| --- | --- |
| Windows or Linux desktop, Chrome | Apple Pay listed; choosing it opens the QR dialog |
| Android phone, Chrome | Apple Pay **not** listed; KNET navigates in the same tab |
| iPhone, Safari | Apple Pay listed; choosing it goes straight to the hosted page in the same tab, with no "popup blocked" toast |
| iPhone, portal opened from a WhatsApp or email link | no QR either way; Apple Pay listed only if that webview exposes `ApplePaySession` |
| macOS Safari with Apple Pay set up | Apple Pay listed; opens in a new tab; **no** QR |
| **iPad or Android tablet** | Apple Pay listed; a tablet without `ApplePaySession` still gets the **QR**, not `unavailable` — this is what the `isPhone` size term protects |
| **Windows desktop, KNET, successful payment** | Record whether a "popup blocked" toast appears **alongside** the gateway tab opening. If it does, the suspected `noopener` null-return defect is confirmed — file it as a follow-up, do not fix it here |
| **Google Pay from an iPhone, and from a WhatsApp webview** | reaches the hosted page. Google Pay is *not* an exact mirror of Apple Pay — readiness depends on browser, device and account — so test it rather than assuming "runs anywhere". This plan changes no Google Pay logic; the row exists to catch a surprise, and anything found becomes its own ticket |

If a physical device is unavailable, Chrome DevTools device emulation exercises `isPhone` (it sets a coarse pointer, non-zero `maxTouchPoints` and a phone-sized viewport) but **not** `canUseApplePay` — emulation cannot fake `ApplePaySession`. Say which rows were emulated and which were real; an emulated iPhone tests the Android-phone row, not the iPhone one.

- [ ] **Step 4: Full manual sweep**

With `bun run dev`, walk every portal screen — `/portal`, `/portal/lease`, `/portal/invoices`, `/portal/payments`, `/portal/profile`, `/portal/auth` — at **360px**, **390px**, **414px** and **768px**, in **both** `ar` and `en`, checking:

- no horizontal page scroll at any width;
- every interactive control at least 44×44px under a coarse pointer;
- the sticky pay bar on `/portal/invoices` does not cover the last invoice row;
- RTL mirroring intact — nothing has jumped to the wrong edge.

Record which combinations were actually checked. Do not claim a device class that was not opened.

- [ ] **Step 5: Run the full gates**

```bash
bun run lint && bun run typecheck && bun run test && bun run format
```

Expected: all PASS. Paste the real output — a summary is not evidence.

- [ ] **Step 6: Commit**

```bash
git add src/routes/portal.index.tsx
git commit -m "fix(portal): step the dashboard hero stats to three columns at md"
```

---

## Definition of done

- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run format` all pass, with output shown.
- [ ] `paymentHandoff.test.ts` covers every method × device-class pair, and the "KNET and Google Pay never QR" invariant still holds.
- [ ] No new i18n keys; `dictionary.test.ts` passes.
- [ ] No file crossed 500 lines: `wc -l src/routes/portal.invoices.tsx src/routes/portal.payments.tsx`.
- [ ] Every function **touched** — not only every new one — carries an Arabic-first doc comment above it.
- [ ] No `pl-*`/`pr-*`/`left-*`/`right-*` introduced: `git diff main -- src | grep -nE '^\+.*\b(pl|pr|ml|mr)-[0-9]'` returns nothing.
- [ ] `isPaymentMethodOffered` and `paymentHandoffFor` agree on every input — the cross-check test in Task 1 passes.
- [ ] The desktop `window.open` branch in `portal.invoices.tsx` is **unchanged**, and the device matrix records whether a successful desktop payment showed a spurious "popup blocked" toast.
- [ ] Manual sweep recorded with the actual widths and locales checked, and the device matrix records which rows were physical and which were emulated.
- [ ] `clean-code-guard` on the production diff, `test-guard` on the test diff, `docs-guard` on the doc-comment changes.
