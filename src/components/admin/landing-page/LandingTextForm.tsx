import type React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  type LandingPageSettingsWithMedia,
  useUpdateLandingSettings,
} from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";

interface LandingTextFormProps {
  activeSettings: LandingPageSettingsWithMedia | null | undefined;
  editLang: "ar" | "en";
}

/**
 * نموذج نصوص صفحة الهبوط (الواجهة، عن المجمع، التأجير) للغة المحرَّرة.
 *
 * Extracted unchanged from the landing-page settings route (plan row 6.7).
 * The form is keyed on `editLang` inside, which remounts the uncontrolled
 * inputs on a language switch — without that, the previous locale's text
 * would be saved over the other locale's row.
 */
export function LandingTextForm({ activeSettings, editLang }: LandingTextFormProps) {
  const { t } = useI18n();
  const updateSettings = useUpdateLandingSettings();

  // Handles updating settings text fields
  const handleSaveTextSettings = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeSettings) return;

    const formData = new FormData(e.currentTarget);
    const updates = {
      hero_title: formData.get("hero_title") as string,
      hero_subtitle: formData.get("hero_subtitle") as string,
      hero_primary_cta_label: formData.get("hero_primary_cta_label") as string,
      hero_primary_cta_target: formData.get("hero_primary_cta_target") as string,
      hero_secondary_cta_label: formData.get("hero_secondary_cta_label") as string,
      hero_secondary_cta_target: formData.get("hero_secondary_cta_target") as string,
      about_title: formData.get("about_title") as string,
      about_body: formData.get("about_body") as string,
      leasing_title: formData.get("leasing_title") as string,
      leasing_body: formData.get("leasing_body") as string,
      is_published: true,
      published_at: new Date().toISOString(),
    };

    try {
      await updateSettings.mutateAsync({ id: activeSettings.id, updates });
      toast.success(t("settings.saved"));
    } catch (err) {
      toast.error(t("settings.saveError"));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("landingSettings.editLandingTextContents")} ({editLang.toUpperCase()})
        </CardTitle>
        <CardDescription>{t("landingSettings.modifyHeroVisualTextAbout")}</CardDescription>
      </CardHeader>
      <CardContent>
        {activeSettings ? (
          // key remounts the uncontrolled inputs when switching editor
          // language — otherwise defaultValue keeps the previous
          // locale's text and saving overwrites the other locale's row.
          <form key={editLang} onSubmit={handleSaveTextSettings} className="space-y-6">
            <div className="space-y-4">
              <h3 className="font-bold border-b pb-2 text-primary">
                {t("landingSettings.heroBannerSection")}
              </h3>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label required htmlFor="hero_title">
                    {t("landingSettings.heroTitle")}
                  </Label>
                  <Input
                    id="hero_title"
                    name="hero_title"
                    defaultValue={activeSettings.hero_title}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label required htmlFor="hero_subtitle">
                    {t("landingSettings.heroSubtitle")}
                  </Label>
                  <Textarea
                    id="hero_subtitle"
                    name="hero_subtitle"
                    defaultValue={activeSettings.hero_subtitle}
                    rows={3}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hero_primary_cta_label">
                    {t("landingSettings.primaryCtaLabel")}
                  </Label>
                  <Input
                    id="hero_primary_cta_label"
                    name="hero_primary_cta_label"
                    defaultValue={activeSettings.hero_primary_cta_label || ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hero_primary_cta_target">
                    {t("landingSettings.primaryCtaTargetLink")}
                  </Label>
                  <Input
                    id="hero_primary_cta_target"
                    name="hero_primary_cta_target"
                    defaultValue={activeSettings.hero_primary_cta_target || ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hero_secondary_cta_label">
                    {t("landingSettings.secondaryCtaLabel")}
                  </Label>
                  <Input
                    id="hero_secondary_cta_label"
                    name="hero_secondary_cta_label"
                    defaultValue={activeSettings.hero_secondary_cta_label || ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hero_secondary_cta_target">
                    {t("landingSettings.secondaryCtaTargetLink")}
                  </Label>
                  <Input
                    id="hero_secondary_cta_target"
                    name="hero_secondary_cta_target"
                    defaultValue={activeSettings.hero_secondary_cta_target || ""}
                  />
                </div>
              </div>

              <h3 className="font-bold border-b pb-2 pt-4 text-primary">
                {t("landingSettings.aboutComplexSection")}
              </h3>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label required htmlFor="about_title">
                    {t("landingSettings.aboutTitle")}
                  </Label>
                  <Input
                    id="about_title"
                    name="about_title"
                    defaultValue={activeSettings.about_title}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label required htmlFor="about_body">
                    {t("landingSettings.aboutDescriptionParagraphs")}
                  </Label>
                  <Textarea
                    id="about_body"
                    name="about_body"
                    defaultValue={activeSettings.about_body}
                    rows={5}
                    required
                  />
                </div>
              </div>

              <h3 className="font-bold border-b pb-2 pt-4 text-primary">
                {t("landingSettings.leasingPromotionCta")}
              </h3>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label required htmlFor="leasing_title">
                    {t("landingSettings.leasingTitle")}
                  </Label>
                  <Input
                    id="leasing_title"
                    name="leasing_title"
                    defaultValue={activeSettings.leasing_title}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label required htmlFor="leasing_body">
                    {t("landingSettings.leasingContentDescription")}
                  </Label>
                  <Textarea
                    id="leasing_body"
                    name="leasing_body"
                    defaultValue={activeSettings.leasing_body}
                    rows={3}
                    required
                  />
                </div>
              </div>
            </div>
            <Button type="submit" disabled={updateSettings.isPending}>
              {updateSettings.isPending ? t("common.loading") : t("common.save")}
            </Button>
          </form>
        ) : (
          <div className="text-sm text-destructive">No Settings found for this language.</div>
        )}
      </CardContent>
    </Card>
  );
}
