import { describe, expect, it } from "vitest";

import { isPortalTabVisible, PORTAL_TABS, portalTabForPath, visiblePortalTabs } from "./portalTabs";

const shopTab = PORTAL_TABS.find((t) => t.key === "shop")!;
const ALL_GRANTED = new Set(PORTAL_TABS.map((t) => t.permission as string));
const NONE_GRANTED = new Set<string>();

/**
 * تبويب متجري لا يظهر إلا لمن يملك متجراً — حتى لو كان الدور يمنحه.
 *
 * الخاصية `requiresLinkedShop` مُعلنة على التبويب نفسه، ويُمرر
 * `hasLinkedShop` عبر `isPortalTabVisible` كخيار إضافي.
 */
describe("portalTabs — shop tab requires linked shop", () => {
  it("يُخفي المتجر عندما لا يملك المستأجر متجراً حتى مع صلاحية الدور", () => {
    expect(isPortalTabVisible(shopTab, {}, ALL_GRANTED, { hasLinkedShop: false })).toBe(false);
  });

  it("يُظهر المتجر عندما يملك المستأجر متجراً وكانت الصلاحية ممنوحة", () => {
    expect(isPortalTabVisible(shopTab, {}, ALL_GRANTED, { hasLinkedShop: true })).toBe(true);
  });

  it("لا يظهر المتجر أثناء التحميل (hasLinkedShop غير معروف)", () => {
    expect(isPortalTabVisible(shopTab, {}, ALL_GRANTED, { hasLinkedShop: undefined })).toBe(false);
    expect(isPortalTabVisible(shopTab, {}, ALL_GRANTED)).toBe(false);
  });

  it("التجاوز true يُظهره حتى بلا متجر", () => {
    const forceOn = { portal_tab_shop: true } as any;
    expect(isPortalTabVisible(shopTab, forceOn, NONE_GRANTED, { hasLinkedShop: false })).toBe(true);
  });

  it("التجاوز false يُخفيه حتى مع متجر", () => {
    const forceOff = { portal_tab_shop: false } as any;
    expect(isPortalTabVisible(shopTab, forceOff, ALL_GRANTED, { hasLinkedShop: true })).toBe(false);
  });

  it("visiblePortalTabs لا يتضمن المتجر بلا متجر مرتبط", () => {
    const tabs = visiblePortalTabs({}, ALL_GRANTED, { hasLinkedShop: false }).map((t) => t.key);
    expect(tabs).not.toContain("shop");
  });

  it("visiblePortalTabs يتضمن المتجر مع متجر مرتبط", () => {
    const tabs = visiblePortalTabs({}, ALL_GRANTED, { hasLinkedShop: true }).map((t) => t.key);
    expect(tabs).toContain("shop");
  });

  it("portalTabForPath يحل /portal/shop", () => {
    expect(portalTabForPath("/portal/shop")?.key).toBe("shop");
  });

  it("portalTabForPath يحل المسارات الفرعية تحت المتجر", () => {
    expect(portalTabForPath("/portal/shop/edit")?.key).toBe("shop");
  });
});
