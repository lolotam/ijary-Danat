import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ImageSourceInput } from "@/components/admin/ImageSourceInput";
import { AdminShopsSection } from "@/components/admin/landing-page/AdminBrandDialog";
import { CompanyContactForm } from "@/components/admin/landing-page/CompanyContactForm";
import { GalleryPanel } from "@/components/admin/landing-page/GalleryPanel";
import { LandingTextForm } from "@/components/admin/landing-page/LandingTextForm";
import { SectionsPanel } from "@/components/admin/landing-page/SectionsPanel";
import { SlidesPanel } from "@/components/admin/landing-page/SlidesPanel";
import { useCompany, useUpdateCompany } from "@/hooks/useCompany";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import { useI18n } from "@/i18n/provider";
import {
  useLandingMedia,
  useLandingSections,
  useLandingSettings,
  useLandingSlides,
} from "@/hooks/useLandingSettings";

export const Route = createFileRoute("/admin/settings/landing-page")({
  component: AdminLandingPageSettings,
});

/**
 * إعدادات صفحة الهبوط العامة: الأقسام والمحلات والشرائح والمعرض والموقع.
 *
 * جداول المحلات والشرائح والمعرض مُستخرجة إلى مكوّنات البطاقات؛ أهداف اللمس
 * تُكبَّر على الأجهزة اللمسية، وكل النصوص تمرّ عبر كتالوج الترجمة.
 */
function AdminLandingPageSettings() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const [editLang, setEditLang] = useState<"ar" | "en">("ar");
  // landing_page.read opens the editor and its drafts; landing_page.update is
  // what the landing tables AND the landing bucket check (migration 230), so
  // saving and uploading share one grant.
  const canView =
    !permissions.isLoading &&
    permissions.canAny([PERMISSIONS.LANDING_PAGE_READ, PERMISSIONS.LANDING_PAGE_UPDATE]);
  const canEdit = permissions.can(PERMISSIONS.LANDING_PAGE_UPDATE);
  const canUploadLandingImages = canEdit;
  const landingUploadHint = canUploadLandingImages
    ? undefined
    : t("landingSettings.uploadingLandingImagesRequiresAn");

  // Fetch queries (staff only — tenants hit RLS walls and hung upload spinners)
  const { data: settingsAr, isLoading: loadingAr } = useLandingSettings("ar", canView);
  const { data: settingsEn, isLoading: loadingEn } = useLandingSettings("en", canView);
  const { data: sections, isLoading: loadingSections } = useLandingSections(canView);
  const { data: slides, isLoading: loadingSlides } = useLandingSlides(canView);
  const { data: mediaItems, isLoading: loadingMedia } = useLandingMedia(undefined, canView);

  const company = useCompany(canView);
  const updateCompany = useUpdateCompany();

  if (permissions.isLoading) {
    return <div className="text-sm text-muted-foreground p-6">{t("common.loading")}</div>;
  }
  if (!canView) {
    return <p className="text-destructive p-6">{t("common.notAuthorized")}</p>;
  }
  if (loadingAr || loadingEn || loadingSections || loadingSlides || loadingMedia) {
    return <div className="text-sm text-muted-foreground p-6">{t("common.loading")}</div>;
  }

  const activeSettings = editLang === "ar" ? settingsAr : settingsEn;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.landingPage")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("landingSettings.managePublicLandingPageSections")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={editLang === "ar" ? "default" : "outline"}
            onClick={() => setEditLang("ar")}
          >
            العربية
          </Button>
          <Button
            variant={editLang === "en" ? "default" : "outline"}
            onClick={() => setEditLang("en")}
          >
            English
          </Button>
        </div>
      </div>

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="flex w-full h-auto gap-1 justify-start overflow-x-auto [&>*]:shrink-0 md:grid md:grid-cols-8">
          <TabsTrigger value="general">{t("landingSettings.sections")}</TabsTrigger>
          <TabsTrigger value="hero">{t("landingSettings.heroAbout")}</TabsTrigger>
          <TabsTrigger value="brands">{t("landingSettings.shops")}</TabsTrigger>
          <TabsTrigger value="slides">{t("landingSettings.slides")}</TabsTrigger>
          <TabsTrigger value="gallery">{t("landingSettings.gallery")}</TabsTrigger>
          <TabsTrigger value="location">{t("landingSettings.location")}</TabsTrigger>
          <TabsTrigger value="portal">{t("landingSettings.portal")}</TabsTrigger>
        </TabsList>

        {!canEdit && (
          <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {t("landingSettings.readOnlyNotice")}
          </p>
        )}

        {/* A disabled fieldset disables every native control beneath it —
            buttons, inputs, and the Radix switches/selects that render as
            buttons — so a landing_page.read role can browse the editor without
            reaching a save that RLS will refuse. The tab triggers sit outside
            it and stay clickable. */}
        <fieldset disabled={!canEdit} className="contents">
          {/* 1. SECTIONS TOGGLES */}
          <TabsContent value="general" className="mt-4">
            <SectionsPanel sections={sections} />
          </TabsContent>

          {/* 2. HERO & ABOUT EDIT */}
          <TabsContent value="hero" className="mt-4">
            <LandingTextForm activeSettings={activeSettings} editLang={editLang} />
          </TabsContent>

          <TabsContent value="brands" className="mt-4">
            <AdminShopsSection />
          </TabsContent>

          {/* 4. CAROUSEL SLIDES */}
          <TabsContent value="slides" className="mt-4">
            <SlidesPanel
              slides={slides}
              mediaItems={mediaItems}
              companyId={settingsAr?.company_id}
              canUploadLandingImages={canUploadLandingImages}
              landingUploadHint={landingUploadHint}
            />
          </TabsContent>

          {/* 5. PHOTO GALLERY */}
          <TabsContent value="gallery" className="mt-4">
            <GalleryPanel
              mediaItems={mediaItems}
              canUploadLandingImages={canUploadLandingImages}
              landingUploadHint={landingUploadHint}
            />
          </TabsContent>

          {/* 6. LOCATION MAP & COORDINATES */}
          <TabsContent value="location" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("landingSettings.locationContactDetails")}</CardTitle>
                <CardDescription>
                  {t("landingSettings.updateAddressPhoneWhatsappAnd")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {company.data ? (
                  <CompanyContactForm
                    company={company.data}
                    updateCompany={updateCompany}
                    t={t}
                    locale={locale}
                  />
                ) : company.isLoading ? (
                  <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                ) : (
                  <p className="text-sm text-destructive">
                    {t("landingSettings.companyDataCouldNotBe")}
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* PORTAL SIGN-IN PAGE BACKGROUND */}
          <TabsContent value="portal" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("settings.portalBackground")}</CardTitle>
                <CardDescription>
                  {t("landingSettings.backgroundImageForTheTenant")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ImageSourceInput
                  value={company.data?.portal_bg_url ?? ""}
                  bucket="landing"
                  canUpload={canUploadLandingImages}
                  uploadHint={landingUploadHint}
                  folder="portal"
                  onChange={async (url) => {
                    if (!company.data) return;
                    try {
                      await updateCompany.mutateAsync({
                        id: company.data.id,
                        updates: { portal_bg_url: url.trim() || null },
                      });
                      toast.success(t("settings.saved"));
                    } catch (e: any) {
                      toast.error(e.message || t("settings.saveError"));
                    }
                  }}
                />
                {company.data?.portal_bg_url ? (
                  <img
                    src={company.data.portal_bg_url}
                    alt=""
                    className="max-h-64 w-full rounded-lg border object-cover"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("landingSettings.noImageSetAPlaceholder")}
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </fieldset>
      </Tabs>
    </div>
  );
}
