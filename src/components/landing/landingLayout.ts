import { useCompany } from "@/hooks/useCompany";
import { useHostBrandName } from "@/hooks/useHostBrandName";
import type { CommercialBrand } from "@/hooks/useLandingSettings";
import { useMapEmbed } from "@/hooks/useMapEmbed";
import { useI18n } from "@/i18n/provider";

/**
 * عرض المحتوى الموحّد لكل أقسام صفحة الهبوط.
 *
 * Every section used the same width/gutter string through a local `pageShell`
 * const; it is shared here now that the sections are separate components.
 */
export const PAGE_SHELL = "mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-10 xl:px-14";

/** صف علامة تجارية كما تعيده الاستعلامات مع صورتَي الشعار والغلاف. */
export type BrandRow = CommercialBrand & {
  logo?: { storage_path: string } | null;
  cover?: { storage_path: string } | null;
};

/**
 * صورة بطاقة المحل: الغلاف إن وُجد وإلا الشعار.
 *
 * Prefer shop-card cover image; fall back to logo for older brands.
 */
export function brandCardImage(brand: BrandRow): string | null {
  return brand.cover?.storage_path || brand.logo?.storage_path || null;
}

/**
 * يحوّل عدد البطاقات في الصف (من إعدادات القسم) إلى أصناف الشبكة المتجاوبة.
 */
export function gridColsClass(cols: number): string {
  const map: Record<number, string> = {
    2: "grid-cols-1 min-[390px]:grid-cols-2",
    3: "grid-cols-1 min-[390px]:grid-cols-2 sm:grid-cols-3",
    4: "grid-cols-1 min-[390px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
    5: "grid-cols-1 min-[390px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5",
    6: "grid-cols-1 min-[390px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6",
    7: "grid-cols-1 min-[390px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7",
    8: "grid-cols-1 min-[390px]:grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-8",
  };
  return map[cols] ?? map[6];
}

/** يحذف كل ما ليس رقماً. */
function digitsOnly(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

/** يبني رابط اتصال `tel:` من رقم الهاتف، أو null إن لم يبقَ رقم. */
function telHref(phone: string | null | undefined) {
  const cleaned = (phone ?? "").replace(/[^\d+]/g, "");
  return cleaned ? `tel:${cleaned}` : null;
}

/** يبني رابط محادثة واتساب من الرقم بعد حذف ما ليس رقماً. */
function whatsappHref(whatsapp: string | null | undefined) {
  const digits = digitsOnly(whatsapp);
  return digits ? `https://wa.me/${digits}` : null;
}

/** يعيد رابط الخريطة كما أدخله المسؤول، أو null إن كان فارغاً. */
function mapsHref(mapUrl: string | null | undefined) {
  const url = mapUrl?.trim();
  return url || null;
}

/** بيانات التواصل المشتقة من صف الشركة كما تعرضها الصفحة العامة. */
export interface LandingContact {
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyMapUrl: string | null;
  companyPhoneHref: string | null;
  companyWhatsappHref: string | null;
  companyMapsHref: string | null;
  companyMapsEmbed: string | null;
  companyInstagram: string | null;
  companyFacebook: string | null;
  companyDisplayName: string;
}

/**
 * يقرأ صف الشركة ويشتق منه روابط الهاتف والواتساب والخريطة واسم العرض.
 *
 * Moved verbatim out of the page component. Short share links
 * (maps.app.goo.gl/...) only yield coordinates after a server-side redirect
 * follow, so the embed src is resolved rather than guessed.
 */
export function useLandingContact(): LandingContact {
  const { locale } = useI18n();
  const { data: company } = useCompany();
  // The last resort is the host's public name, not a fixed company's: the
  // company row may still be loading when the page first paints.
  const hostBrandName = useHostBrandName();
  const companyAddress =
    (locale === "ar" ? company?.address_ar : company?.address_en) ||
    company?.address_ar ||
    company?.address_en ||
    null;
  const companyPhone = company?.phone?.trim() || null;
  const companyEmail = company?.email?.trim() || null;
  const companyWhatsapp = company?.whatsapp?.trim() || companyPhone;
  const companyMapUrl = company?.map_url?.trim() || null;
  const companyPhoneHref = telHref(companyPhone);
  const companyWhatsappHref = whatsappHref(companyWhatsapp);
  const companyMapsHref = mapsHref(companyMapUrl);
  const mapEmbed = useMapEmbed(companyMapUrl);
  const companyMapsEmbed = mapEmbed.data?.embedSrc ?? null;
  const companyInstagram = company?.instagram_url?.trim() || null;
  const companyFacebook = company?.facebook_url?.trim() || null;
  const companyDisplayName =
    (locale === "ar" ? company?.name_ar : company?.name_en) ||
    company?.name_ar ||
    company?.name_en ||
    hostBrandName;
  return {
    companyAddress,
    companyPhone,
    companyEmail,
    companyMapUrl,
    companyPhoneHref,
    companyWhatsappHref,
    companyMapsHref,
    companyMapsEmbed,
    companyInstagram,
    companyFacebook,
    companyDisplayName,
  };
}
