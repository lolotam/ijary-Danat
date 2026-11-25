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
 *
 * Compact tablets lose out, and that is deliberate. An iPad mini (744px) or a
 * 7–8" Android tablet (600–720px) is classified a phone, so if it cannot open
 * the Apple Pay sheet the method is hidden rather than QR'd — it keeps KNET and
 * Google Pay. Lowering the threshold to rescue them would start showing an
 * unscannable QR on an unfolded foldable (~674px), which is the exact defect
 * this whole change exists to remove. The error direction matters more than the
 * error rate: fail toward "no Apple Pay", never toward "a QR you cannot scan".
 */
const PHONE_MAX_EDGE_PX = 768;

/**
 * الحالة قبل الفحص: حاسوب مكتبي.
 *
 * The safe direction. A desktop profile yields the QR, which is a working path
 * on every device; guessing "phone" would hide Apple Pay from a Mac.
 */
const DESKTOP_PROFILE: PaymentDeviceProfile = { canUseApplePay: false, isPhone: false };

/**
 * يتحقق من قدرة هذا المتصفح على فتح صفحة Apple Pay، ويعتبر أي خطأ إجابة بالنفي.
 *
 * `canMakePayments()` throws in an insecure or cross-origin-framed context. The
 * throw *is* the answer — the sheet cannot open here — so it is converted to
 * `false` rather than allowed to escape and take down the invoices route.
 */
export function readCanUseApplePay(): boolean {
  try {
    return window.ApplePaySession?.canMakePayments?.() === true;
  } catch (error) {
    console.error("Probing Apple Pay availability failed; treating it as unavailable.", error);
    return false;
  }
}

/**
 * يتحقق من كون الجهاز هاتفًا: مؤشر خشن، ولمس حقيقي، وشاشة صغيرة.
 *
 * Probed separately from Apple Pay on purpose. Folding both into one `try` meant
 * a throwing `canMakePayments()` — which happens exactly in the embedded
 * webviews this change targets — also collapsed `isPhone` to false, and the
 * phone was handed the unscannable QR all over again.
 */
export function readIsPhone(): boolean {
  try {
    return (
      window.matchMedia("(pointer: coarse)").matches &&
      navigator.maxTouchPoints > 0 &&
      Math.min(window.screen.width, window.screen.height) < PHONE_MAX_EDGE_PX
    );
  } catch (error) {
    console.error("Reading the device pointer profile failed; assuming desktop.", error);
    return false;
  }
}

/**
 * يقرأ قدرات الجهاز من متصفحه.
 *
 * The two probes fail independently — see `readIsPhone`.
 */
function readDeviceProfile(): PaymentDeviceProfile {
  return { canUseApplePay: readCanUseApplePay(), isPhone: readIsPhone() };
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
