import { describe, expect, test } from "vitest";

import { toAspectRatio } from "./videoAspect";

/**
 * يثبت اشتقاق نسبة العرض إلى الارتفاع من أبعاد الفيديو مع حماية
 * القيم الصفرية وغير المنتهية التي قد تأتي من onLoadedMetadata قبل الجاهزية.
 */
describe("toAspectRatio", () => {
  test("أبعاد 1920x1080 تعود كما هي نسبةً", () => {
    expect(toAspectRatio(1920, 1080)).toBe("1920 / 1080");
  });

  test("مربّع يعود 1 / 1", () => {
    expect(toAspectRatio(720, 720)).toBe("720 / 720");
  });

  test("صفر في أي بُعد يعود null (يبقى الهيكل 4:3)", () => {
    expect(toAspectRatio(0, 1080)).toBeNull();
    expect(toAspectRatio(1920, 0)).toBeNull();
    expect(toAspectRatio(0, 0)).toBeNull();
  });

  test("قيم سالبة تعود null", () => {
    expect(toAspectRatio(-640, 480)).toBeNull();
    expect(toAspectRatio(640, -480)).toBeNull();
  });

  test("غير منتهية (NaN/Infinity) تعود null", () => {
    expect(toAspectRatio(NaN, 1080)).toBeNull();
    expect(toAspectRatio(1920, Infinity)).toBeNull();
    expect(toAspectRatio(Infinity, Infinity)).toBeNull();
  });
});
