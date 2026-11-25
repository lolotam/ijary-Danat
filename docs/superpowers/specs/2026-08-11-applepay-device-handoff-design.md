# Device-aware Apple Pay handoff — design

**Date:** 2026-08-11
**Status:** approved, ready for implementation planning
**Scope:** client-side only. No migration, no server function, no env var, no
MyFatoorah API change.

## Problem

`/portal/invoices` offers three hosted payment methods. Apple Pay cannot run in
every browser, so the portal falls back to a QR code that the tenant scans with
an iPhone — see `ApplePayQrDialog`. The decision lives in one pure function:

```ts
// src/lib/paymentHandoff.ts (current)
return input.method === "APPLE_PAY" && !input.canUseApplePay ? "show-qr" : "open-tab";
```

`canUseApplePay` is probed once on mount in `src/routes/portal.invoices.tsx`:

```ts
setCanUseApplePay(window.ApplePaySession?.canMakePayments?.() === true);
```

That probe asks **"can this browser open the Apple Pay sheet"**. The QR fallback
needs the answer to a different question: **"is there a second device to hand
this payment to"**. Where those two questions disagree, the portal does the
wrong thing.

### Defect 1 — a QR code shown on the device that would have to scan it

Any handheld whose browser cannot run Apple Pay is sent a QR code it cannot
scan with itself. Two real cases:

- **Android phones.** Apple Pay is offered in the menu, and choosing it produces
  an unscannable QR. This is the case that was observed in production use.
- **iPhones opening the portal from a WhatsApp or email link.** In-app webviews
  do not expose `ApplePaySession`, so `canUseApplePay` is `false` on an iPhone
  that could otherwise pay. This platform sends portal links over both WhatsApp
  and email, so it is a common entry path rather than an edge case.

iPhone + Safari is **not** affected: `ApplePaySession.canMakePayments()` returns
`true` there and the handoff already resolves to `open-tab`.

### Defect 2 — `window.open` after an `await` is blocked on iOS

`paySelected` opens the gateway *after* awaiting the payment-request round trip:

```ts
const result = await createPayment.mutateAsync({ ... });   // portal.invoices.tsx:154
const opened = window.open(result.paymentUrl, "_blank", ...); // :170
```

iOS Safari honours `window.open` only inside a live user-gesture call stack; the
activation is spent by the time the network call resolves. The iPhone flow
therefore lands on the "popup blocked" toast with a manual link rather than on
the Apple Pay page. It is recoverable, but it adds a tap to the one screen that
must not have friction.

The comment at `portal.invoices.tsx:168` justifies the new tab as preserving the
portal session. That reason does not hold on mobile: the Supabase session lives
in storage rather than in the tab, and the gateway redirects to
`/portal/payments/callback`, which restores auth itself (it sits deliberately
outside the `/portal` layout for exactly this reason). Same-tab navigation is
therefore at least as safe on a handheld, and strictly more reliable.

## Approach

Widen the handoff decision from one boolean to a two-field **device profile**,
and add a second pure function that decides which methods are offered at all.

### Why a pointer probe, not a width probe or a user agent

`useIsMobile()` exists in this codebase and is the tempting input. It is
`max-width: 767px` — a *viewport* probe — and it is wrong here:

- A desktop user who narrows their browser window would lose the QR, which is
  their only working Apple Pay path.
- An iPad in split view would flip behaviour mid-session.

User-agent sniffing is also wrong: iPad Safari reports a desktop-class UA, and
the existing code comment at `portal.invoices.tsx:24-27` already rejects UA
sniffing for good reason.

The correct signal is the **primary pointer**:

```ts
matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0
```

`(pointer: coarse)` describes the primary input device, so a Surface with a
mouse attached reports `fine` and keeps its QR. `(any-pointer: coarse)` would
be wrong — it is true for any touch-capable device including touchscreen
laptops driven by a mouse.

## Design

### Types

```ts
/** ما الذي يستطيع هذا الجهاز فعله بشأن الدفع. */
export interface PaymentDeviceProfile {
  /** window.ApplePaySession?.canMakePayments?.() === true */
  canUseApplePay: boolean;
  /** جهاز محمول: مؤشر خشن ولمس حقيقي — هاتف أو لوح. */
  isHandheld: boolean;
}

export type PaymentHandoff = "open-tab" | "open-same-tab" | "show-qr";
```

### Decision table

`paymentHandoffFor({ method, device })`:

| method | canUseApplePay | isHandheld | example device | offered | handoff |
| --- | --- | --- | --- | --- | --- |
| APPLE_PAY | false | false | Windows / Linux / Android desktop | yes | `show-qr` |
| APPLE_PAY | false | true | Android phone; iPhone in WhatsApp webview | **no** | `open-same-tab` (unreachable via UI) |
| APPLE_PAY | true | false | macOS Safari with Apple Pay | yes | `open-tab` |
| APPLE_PAY | true | true | iPhone / iPad Safari | yes | `open-same-tab` |
| KNET, GOOGLE_PAY | any | false | any desktop | yes | `open-tab` |
| KNET, GOOGLE_PAY | any | true | any handheld | yes | `open-same-tab` |

Read as rules, in order:

1. `method === "APPLE_PAY" && !canUseApplePay && !isHandheld` → `show-qr`
2. `isHandheld` → `open-same-tab`
3. otherwise → `open-tab`

Rule 1 preserves the existing invariant that KNET and Google Pay can **never**
produce a QR — the regression the current test guards against.

Row 2 is unreachable through the UI because the method is not offered, but the
function stays total and is tested at that input anyway: a partial function
would invite a crash the day another caller appears.

### Offered methods

`offeredPaymentMethods(device): readonly HostedPaymentMethod[]`

Drops `APPLE_PAY` if and only if `isHandheld && !canUseApplePay`. KNET and
Google Pay are always offered. This is what removes the dead option from the
Android menu, and it needs no new copy — a hidden item needs no explanation
string, so no i18n keys are added and `dictionary.test.ts` parity is unaffected.

### The probe

A new hook, `src/hooks/useDeviceProfile.ts`, resolves the profile in a mount
effect and returns `{ canUseApplePay: false, isHandheld: false }` until it does.
That default is the desktop profile, which is the safe pre-probe state: it
yields the QR rather than a dead Apple Pay button.

The probe stays in an effect rather than running during render even though
`/portal` is `ssr: false` (`src/routes/portal.tsx:36`). Reading `window` during
render is a hydration hazard that the route config could silently stop
protecting against.

### Call-site changes

`src/routes/portal.invoices.tsx`

- Replace the `canUseApplePay` state and its effect with `useDeviceProfile()`.
- `paySelected` switches on the three-way handoff:
  - `show-qr` → set `applePayHandoff`, as today.
  - `open-same-tab` → `window.location.assign(result.paymentUrl)`.
  - `open-tab` → `window.open(..., "_blank", "noopener,noreferrer")` with the
    existing popup-blocked toast fallback, unchanged.
- Pass `methods={offeredPaymentMethods(device)}` to `PayNowMenu`.

`src/components/portal/PayNowMenu.tsx`

- Take a `methods: readonly HostedPaymentMethod[]` prop and render only those,
  preserving the declared order in `paymentMethodButtons`.
- The literal `"KNET"` / `"GOOGLE_PAY"` / `"APPLE_PAY"` strings stay in the
  module constant, because `PayNowMenu.test.tsx:43-45` asserts the exact
  underscore spelling in source and a wrong spelling silently breaks the gateway.

The branch that calls `window.location.assign` is kept to a single statement so
that all decision logic lives in the two pure functions. Navigation is not
unit-testable without mocking `window.location`; the way to keep it honest is to
leave nothing in that branch worth testing.

## Testing

`src/lib/paymentHandoff.test.ts` — extend to the full truth table above:

- Windows/Android desktop + Apple Pay → `show-qr` (the QR still exists).
- macOS Safari + Apple Pay → `open-tab` (the regression a naive handheld branch
  would introduce, one dimension over from the currently guarded one).
- iPhone Safari + Apple Pay → `open-same-tab`, and **never** `show-qr`.
- Android phone + Apple Pay → never `show-qr` at any input.
- KNET and Google Pay → never `show-qr`, on either device class. This is the
  existing invariant and its test must survive the signature change.

New tests for `offeredPaymentMethods`:

- Android phone → Apple Pay absent, KNET and Google Pay present.
- iPhone Safari, macOS Safari, Windows desktop → all three present.
- Declared order preserved.

`src/components/portal/PayNowMenu.test.tsx` — assert that a method absent from
`methods` does not render, and that the existing closed-state and exact-string
assertions still hold.

Not unit tested, and deliberately so: the `window.location.assign` call and the
`matchMedia` / `ApplePaySession` probe. Both are one-line reads of browser
globals with no branching; a test of either would assert the mock.

## Manual verification

Unit tests prove the rules; they cannot prove the probe reads what we think it
reads. Confirm on the deployed branch:

| Device | Expected |
| --- | --- |
| Windows Chrome desktop | Apple Pay listed; choosing it shows the QR dialog |
| Android phone Chrome | Apple Pay **not** listed; KNET opens in the same tab |
| iPhone Safari | Apple Pay listed; choosing it goes straight to the hosted page, same tab, no popup toast |
| iPhone via a WhatsApp link | Apple Pay listed only if the webview exposes `ApplePaySession`; no QR either way |

## Out of scope

- Apple Pay merchant-domain verification. Payment runs on MyFatoorah's hosted
  page under their domain; the association file is theirs.
- Any change to `createPayment`, the `PaymentMethod` pinning, or the webhook.
- The QR dialog's polling and settlement behaviour, which is unchanged.
- Portal responsive layout — separate spec,
  `2026-08-11-portal-mobile-responsive-design.md`.
