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

/**
 * وسائل الدفع التي فعّلها المشرف: «كي‑نت» دائمًا، ثم آبل باي وجوجل باي حسب الإعداد.
 *
 * KNET is not a switch. It is the rail every tenant can use, and
 * `paymentHandoffFor` never marks it unavailable, so returning it
 * unconditionally is what makes an empty payment menu unrepresentable —
 * no caller has to defend against one.
 *
 * The order here is the order the tenant sees. It is fixed in code rather than
 * derived from the settings row so that toggling a switch cannot reorder the
 * menu.
 */
export function enabledPaymentMethods(settings: {
  applePay: boolean;
  googlePay: boolean;
}): HostedPaymentMethod[] {
  const methods: HostedPaymentMethod[] = ["KNET"];
  if (settings.googlePay) methods.push("GOOGLE_PAY");
  if (settings.applePay) methods.push("APPLE_PAY");
  return methods;
}

/**
 * ما يُعرض فعليًا على هذا الجهاز: تقاطع ما فعّله المشرف مع ما يقدر الجهاز عليه.
 *
 * Kept as the one definition of that intersection because three callers need
 * it — the menu, the pay handler's guard, and the tests — and the failure mode
 * of a second copy is the one `isPaymentMethodOffered` already warns about: an
 * offered method whose handoff is `unavailable`, i.e. a button that silently
 * does nothing.
 *
 * Never returns an empty array for an `enabled` list built by
 * `enabledPaymentMethods`, since KNET survives every device filter.
 */
export function offeredPaymentMethods(input: {
  device: PaymentDeviceProfile;
  enabled: readonly HostedPaymentMethod[];
}): HostedPaymentMethod[] {
  return input.enabled.filter((method) => isPaymentMethodOffered({ device: input.device, method }));
}
