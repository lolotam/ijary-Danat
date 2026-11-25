import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AboutSection } from "@/components/landing/AboutSection";
import { AnnouncementStrip } from "@/components/landing/AnnouncementStrip";
import { BrandDialog } from "@/components/landing/BrandDialog";
import { BrandsMarquee } from "@/components/landing/BrandsMarquee";
import { FacilitiesSection } from "@/components/landing/FacilitiesSection";
import { GalleryLightbox } from "@/components/landing/GalleryLightbox";
import { GallerySection } from "@/components/landing/GallerySection";
import { HeroSection } from "@/components/landing/HeroSection";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { LeasingCta } from "@/components/landing/LeasingCta";
import { LeasingDialog } from "@/components/landing/LeasingDialog";
import { LocationSection } from "@/components/landing/LocationSection";
import { MidpointSlider } from "@/components/landing/MidpointSlider";
import { PurposeSection } from "@/components/landing/PurposeSection";
import { QuickActions } from "@/components/landing/QuickActions";
import { ShopExplorer } from "@/components/landing/ShopExplorer";
import { VisitorInfoBar } from "@/components/landing/VisitorInfoBar";
import { type BrandRow, useLandingContact } from "@/components/landing/landingLayout";
import {
  useLandingBrands,
  useLandingCategories,
  useLandingMedia,
  useLandingSections,
  useLandingSettings,
  useLandingSlides,
} from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { filterExplorerBrands, filterMarqueeBrands } from "@/lib/landingBrandVisibility";
import { visibleLandingNavigation } from "@/lib/landingNavigation";

export const Route = createFileRoute("/")({
  component: LandingPage,
  head: () => ({
    meta: [
      { title: "Danat Future (Danat-future) — Real Estate & Property Management Platform" },
      {
        name: "description",
        content:
          "Danat Al Jahra — your everyday destination for shopping, dining, and services in the heart of Jahra, Kuwait. دانة الجهراء — وجهتك اليومية للتسوق والخدمات في قلب الجهراء.",
      },
      { property: "og:type", content: "website" },
      { property: "og:title", content: "Danat Al Jahra — دانة الجهراء" },
      {
        property: "og:description",
        content:
          "Your everyday destination for shopping and services in the heart of Jahra, Kuwait.",
      },
      { property: "og:image", content: "/landing/hero.png" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "ShoppingCenter",
          name: "Danat Al Jahra",
          alternateName: "دانة الجهراء",
          address: {
            "@type": "PostalAddress",
            streetAddress: "Marzouq Al-Mutaib St, Block 2",
            addressLocality: "Jahra",
            addressCountry: "KW",
          },
          openingHours: "Mo-Su 08:00-23:30",
          parentOrganization: {
            "@type": "Organization",
            name: "Danat Al Mustaqbal Real Estate",
          },
        }),
      },
    ],
  }),
});

/**
 * صفحة الهبوط العامة: تجمع الأقسام وتملك الحالة التي تتشاركها أكثر من قسم.
 *
 * Each section is its own component in components/landing/ (audit M13, plan
 * row 6.8). The page keeps only what crosses sections: the data queries, the
 * section toggles, the selected brand (set by two sections, read by the
 * dialog), the open photo (set by the gallery, read by the lightbox), the
 * leasing dialog flag, and the mobile menu flag the scroll lock depends on.
 */
function LandingPage() {
  const { t, locale, dir } = useI18n();

  const { data: settings } = useLandingSettings(locale);
  const { data: sections } = useLandingSections();
  const { data: brands } = useLandingBrands();
  const { data: slides } = useLandingSlides();
  const { data: mediaItems } = useLandingMedia();
  const { data: categoryRows } = useLandingCategories();
  const contact = useLandingContact();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState<BrandRow | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [leasingDialogOpen, setLeasingDialogOpen] = useState(false);

  // Lock scroll while the mobile menu or the lightbox covers the page
  useEffect(() => {
    if (mobileMenuOpen || lightboxIndex !== null) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [mobileMenuOpen, lightboxIndex]);

  useEffect(() => {
    const desktopViewport = window.matchMedia("(min-width: 768px)");
    const closeMobileMenu = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileMenuOpen(false);
    };
    desktopViewport.addEventListener("change", closeMobileMenu);
    return () => desktopViewport.removeEventListener("change", closeMobileMenu);
  }, []);

  // Section check helper
  const isSectionEnabled = (key: string) => {
    if (!sections) return true; // fallback
    return sections.find((s) => s.section_key === key)?.enabled !== false;
  };

  /** Cards-per-row from section settings_json (admin-controlled). */
  const sectionColumns = (key: string, fallback: number) => {
    const raw = (
      sections?.find((s) => s.section_key === key)?.settings_json as
        | { columns_per_row?: number }
        | null
        | undefined
    )?.columns_per_row;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(8, Math.max(2, Math.round(n)));
  };

  const shopColumns = sectionColumns("shop_explorer", 6);
  const galleryColumns = sectionColumns("gallery", 6);
  const navigationItems = visibleLandingNavigation(isSectionEnabled);
  const hasQuickActions =
    isSectionEnabled("shop_explorer") ||
    Boolean(contact.companyMapsHref || contact.companyWhatsappHref);

  // Public gallery: only media staff opted in via "Show in gallery" (or
  // uploaded under the dedicated Gallery tab). Indices must match between
  // the grid and the lightbox, so both read from this single list.
  const galleryItems = useMemo(
    () => (mediaItems ?? []).filter((m) => m.show_in_gallery === true && m.is_active !== false),
    [mediaItems],
  );

  const marqueeBrands = useMemo(() => brands && filterMarqueeBrands(brands), [brands]);
  const explorerBrands = useMemo(() => brands && filterExplorerBrands(brands), [brands]);

  const categoryName = (categoryId: string | null) => {
    const cat = categoryRows?.find((c) => c.id === categoryId);
    if (!cat) return t("landingPage.retailServices");
    return locale === "ar" ? cat.name_ar : cat.name_en;
  };

  return (
    <div
      dir={dir}
      className="min-h-screen bg-background font-sans text-foreground transition-colors duration-300"
    >
      {isSectionEnabled("announcement") && <AnnouncementStrip />}
      {isSectionEnabled("header") && (
        <LandingHeader
          navigationItems={navigationItems}
          mobileMenuOpen={mobileMenuOpen}
          setMobileMenuOpen={setMobileMenuOpen}
        />
      )}

      <main id="main-content" className={hasQuickActions ? "pb-28 md:pb-0" : undefined}>
        {isSectionEnabled("hero") && (
          <HeroSection settings={settings} isSectionEnabled={isSectionEnabled} />
        )}
        {isSectionEnabled("visitor_info") && <VisitorInfoBar />}
        {isSectionEnabled("about") && (
          <AboutSection settings={settings} isSectionEnabled={isSectionEnabled} />
        )}
        <PurposeSection />
        {isSectionEnabled("brands_marquee") && marqueeBrands && marqueeBrands.length > 0 && (
          <BrandsMarquee marqueeBrands={marqueeBrands} setSelectedBrand={setSelectedBrand} />
        )}
        {isSectionEnabled("shop_explorer") && (
          <ShopExplorer
            explorerBrands={explorerBrands}
            categoryRows={categoryRows}
            categoryName={categoryName}
            shopColumns={shopColumns}
            setSelectedBrand={setSelectedBrand}
          />
        )}
        {isSectionEnabled("midpoint_hero") && slides && slides.length > 0 && (
          <MidpointSlider slides={slides} />
        )}
        {isSectionEnabled("facilities") && <FacilitiesSection />}
        {isSectionEnabled("gallery") && galleryItems.length > 0 && (
          <GallerySection
            galleryItems={galleryItems}
            galleryColumns={galleryColumns}
            setLightboxIndex={setLightboxIndex}
          />
        )}
        {isSectionEnabled("location") && <LocationSection contact={contact} />}
        {isSectionEnabled("leasing") && (
          <LeasingCta
            settings={settings}
            companyWhatsappHref={contact.companyWhatsappHref}
            setLeasingDialogOpen={setLeasingDialogOpen}
          />
        )}
      </main>

      {isSectionEnabled("footer") && (
        <LandingFooter contact={contact} navigationItems={navigationItems} />
      )}
      {hasQuickActions && <QuickActions contact={contact} isSectionEnabled={isSectionEnabled} />}
      <BrandDialog
        selectedBrand={selectedBrand}
        setSelectedBrand={setSelectedBrand}
        categoryName={categoryName}
      />
      <LeasingDialog
        leasingDialogOpen={leasingDialogOpen}
        setLeasingDialogOpen={setLeasingDialogOpen}
      />
      {lightboxIndex !== null && galleryItems.length > 0 && (
        <GalleryLightbox
          galleryItems={galleryItems}
          lightboxIndex={lightboxIndex}
          setLightboxIndex={setLightboxIndex}
        />
      )}
    </div>
  );
}
