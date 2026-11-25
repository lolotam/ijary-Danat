import { describe, expect, it } from "vitest";

import { isValidShopUrl } from "./shopValidation";

/**
 * يتحقق من منع روابط `javascript:` ومهاجمات XSS المخزنة.
 *
 * هذه الروابط تُكتب مباشرة في `href` على الصفحة العامة، لذلك يجب رفض كل
 * ما ليس `http` أو `https`.
 */
describe("shopValidation — isValidShopUrl", () => {
  it("يقبل رابط http عادي", () => {
    expect(isValidShopUrl("http://example.com")).toBe(true);
  });

  it("يقبل رابط https عادي", () => {
    expect(isValidShopUrl("https://example.com/path?x=1")).toBe(true);
  });

  it("يقبل قيمة فارغة لأن الحقل اختياري", () => {
    expect(isValidShopUrl("")).toBe(true);
    expect(isValidShopUrl(null as any)).toBe(true);
  });

  it("يرفض javascript:", () => {
    expect(isValidShopUrl("javascript:alert(1)")).toBe(false);
  });

  it("يرفض حيل الأحرف الكبيرة", () => {
    expect(isValidShopUrl("JavaScript:alert(1)")).toBe(false);
  });

  it("يرفض data: و ftp:", () => {
    expect(isValidShopUrl("data:text/html,hi")).toBe(false);
    expect(isValidShopUrl("ftp://example.com")).toBe(false);
  });

  it("يرفض رابطاً بدون بروتوكول", () => {
    expect(isValidShopUrl("example.com")).toBe(false);
    expect(isValidShopUrl("//example.com")).toBe(false);
  });

  it("يرفض مسافات بيضاء خبيثة قبل البروتوكول الموثوق", () => {
    // trim should make it valid if it's really https; but leading spaces before javascript: should still be rejected after trim
    expect(isValidShopUrl(" javascript:alert(1)")).toBe(false);
  });
});
