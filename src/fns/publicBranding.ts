import { createServerFn } from "@tanstack/react-start";
import type { CSSProperties } from "react";

import { readPublicBranding } from "@/fns/publicBranding.server";

/**
 * بيانات العرض العامة لعلامة الشركة المضيفة: الاسم والشعار والألوان وخلفية البوابة.
 *
 * Nothing else travels through this type: no ids, no settings, no contacts.
 * The sign-in pages and the document renderer are the only consumers, and both
 * only display. Colours are the company's own `brand_primary` / `brand_accent`
 * and may be absent.
 */
export interface PublicBranding {
  nameAr: string;
  nameEn: string;
  brandPrimary: string | null;
  brandAccent: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  portalBgUrl: string | null;
  emailLogoUrl: string | null;
}

/**
 * هوية المنصة (IJARY) لما يفتح الموقع من مضيف بلا شركة: الجذر أو لوحة المشرف العام.
 *
 * Platform branding rather than an empty object so every unauthenticated screen
 * still names its operator; it carries no company data by construction.
 */
export const PLATFORM_BRANDING: PublicBranding = {
  nameAr: "إيجاري",
  nameEn: "IJARY",
  brandPrimary: null,
  brandAccent: null,
  logoUrl: null,
  faviconUrl: null,
  portalBgUrl: null,
  emailLogoUrl: null,
};

/**
 * شعار البريد: الشعار المخصّص للبريد، وإلا شعار التطبيق، وإلا لا شيء.
 *
 * Null is the fallback, not an error: an installation that never uploaded an
 * email logo should still send mail, just without one.
 */
export function emailLogoFor(branding: PublicBranding | null): string | null {
  return branding?.emailLogoUrl ?? branding?.logoUrl ?? null;
}

/**
 * يحوّل لوناً مكتوباً إلى عدده السداسي، أو null إذا لم يكن صالحاً.
 *
 * `brand_primary` and `brand_accent` are free-text settings fields, so a value
 * can be anything. Only `#rgb` / `#rrggbb` are accepted — anything else falls
 * back to the house colours instead of being fed raw into a CSS variable.
 */
function parseHexColor(value: string | null): number | null {
  if (!value) return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, "$&$&") : match[1];
  return Number.parseInt(hex, 16);
}

/**
 * يختار لون نص مقروءاً فوق خلفية سداسية: داكن فوق الفاتح، وأبيض فوق الغامق.
 *
 * The house foregrounds are what this picks between: `#04201d` (the dark ink)
 * and `#ffffff`. Without this a light brand colour would keep the light
 * foreground and the sign-in button would render unreadable.
 */
function readableForegroundOn(rgb: number): string {
  const red = (rgb >> 16) & 0xff;
  const green = (rgb >> 8) & 0xff;
  const blue = rgb & 0xff;
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.6 ? "#04201d" : "#ffffff";
}

/**
 * يبني متغيرات CSS تلوّن أزرار وروابط الصفحة بألوان علامة الشركة إن وُجدت.
 *
 * Overrides the `--primary` / `--accent` pairs that Tailwind 4 resolves through
 * `@theme inline`, so every `bg-primary` / `text-accent` inside the wrapper
 * takes the company's hue, and each colour is paired with a readable
 * foreground. A missing or malformed colour leaves the house theme untouched.
 */
export function brandStyleFor(branding: PublicBranding | null): CSSProperties {
  const style: Record<string, string> = {};
  const pairs: Array<[string, string, string | null]> = [
    ["--primary", "--primary-foreground", branding?.brandPrimary ?? null],
    ["--accent", "--accent-foreground", branding?.brandAccent ?? null],
  ];
  for (const [colorVar, foregroundVar, raw] of pairs) {
    const rgb = parseHexColor(raw);
    if (rgb === null) continue;
    const hex = `#${rgb.toString(16).padStart(6, "0")}`;
    style[colorVar] = hex;
    style[foregroundVar] = readableForegroundOn(rgb);
  }
  return style as CSSProperties;
}

/**
 * يعيد اسم الشركة المضيفة بلغة العرض، أو اسم المنصة على المضيف بلا شركة.
 *
 * The name on the sign-in pages comes from the host's company only — never
 * from a query parameter — so the page cannot be made to impersonate another
 * company by editing the URL.
 */
export function brandNameFor(branding: PublicBranding, locale: string): string {
  return locale === "ar" ? branding.nameAr : branding.nameEn;
}

/** نقطة دخول محمّل المسار لقراءة هوية الشركة العامة من مضيف الطلب. */
export const getPublicBranding = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicBranding> => readPublicBranding(),
);
