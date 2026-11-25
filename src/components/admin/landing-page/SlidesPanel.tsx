import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ImageSourceInput } from "@/components/admin/ImageSourceInput";
import { SlidesTable, type SlideRow } from "@/components/admin/landing-page/SlidesTable";
import {
  type LandingCarouselSlide,
  type LandingMedia,
  type LandingMediaCategory,
  useCreateLandingMedia,
  useCreateSlide,
  useDeleteSlide,
  useUpdateLandingMedia,
  useUpdateSlide,
} from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { mimeTypeFromPath } from "@/lib/imageCompression";
import { planLandingMediaResolution } from "@/lib/resolveLandingMedia";

/**
 * Field shape of the carousel-slide form, mirroring `landing_carousel_slides`.
 *
 * react-hook-form infers its field-name union from `defaultValues` when no
 * generic is supplied. Passing only `is_active`/`display_order` narrowed the
 * union to those two, so every other `register`/`setValue` call was a type
 * error. Naming the shape explicitly is what keeps the two in step.
 *
 * Media ids are held as strings ("" when unset) because the Select components
 * bind to strings; `onSaveSlide` maps empty back to null before it writes.
 */
interface SlideFormValues {
  title_ar: string;
  title_en: string;
  description_ar: string;
  description_en: string;
  cta_label_ar: string;
  cta_label_en: string;
  cta_url: string;
  display_order: number;
  is_active: boolean;
  media_id: string;
  mobile_media_id: string;
}

const SLIDE_FORM_DEFAULTS: SlideFormValues = {
  title_ar: "",
  title_en: "",
  description_ar: "",
  description_en: "",
  cta_label_ar: "",
  cta_label_en: "",
  cta_url: "",
  display_order: 0,
  is_active: true,
  media_id: "",
  mobile_media_id: "",
};

interface SlidesPanelProps {
  slides: LandingCarouselSlide[] | undefined;
  mediaItems: LandingMedia[] | undefined;
  /** شركة صفوف الإعدادات — تُكتب على كل شريحة جديدة. */
  companyId: string | null | undefined;
  canUploadLandingImages: boolean;
  landingUploadHint: string | undefined;
}

/**
 * لوحة شرائح العرض: الجدول وحوار الإضافة والتعديل وحلّ صور الشرائح.
 *
 * Extracted from the landing-page settings route (audit M13, plan row 6.7).
 * The slide form, its dialog state and the media resolution it depends on
 * moved together — they were only ever used by this tab. Behaviour is
 * unchanged; `companyId` is the settings row's company, which the route
 * already loads.
 */
export function SlidesPanel({
  slides,
  mediaItems,
  companyId,
  canUploadLandingImages,
  landingUploadHint,
}: SlidesPanelProps) {
  const { t } = useI18n();
  const createSlide = useCreateSlide();
  const updateSlide = useUpdateSlide();
  const deleteSlide = useDeleteSlide();
  const createMedia = useCreateLandingMedia();
  const updateMedia = useUpdateLandingMedia();

  const [slideDialogOpen, setSlideDialogOpen] = useState(false);
  const [editingSlide, setEditingSlide] = useState<any>(null);
  const [slideImageUrl, setSlideImageUrl] = useState("");
  const [slideMobileImageUrl, setSlideMobileImageUrl] = useState("");
  const [slideImageInGallery, setSlideImageInGallery] = useState(false);

  const {
    register: regSlide,
    handleSubmit: handleSlideSubmit,
    reset: resetSlide,
    setValue: setSlideValue,
    watch: watchSlide,
  } = useForm<SlideFormValues>({
    defaultValues: SLIDE_FORM_DEFAULTS,
  });
  const slideIsActive = watchSlide("is_active");

  /** هل وسيط الصورة مفعَّل للظهور في المعرض العام. */
  function mediaShowInGallery(id: string | null | undefined): boolean {
    if (!id) return false;
    return mediaItems?.find((m) => m.id === id)?.show_in_gallery === true;
  }

  /**
   * يجد صف الوسائط لرابط أو معرّف قائم أو ينشئه، ويزامن إظهاره في المعرض.
   *
   * Resolve (or create) a landing_media row from a URL / existing id and
   * sync the show_in_gallery flag so the public gallery stays opt-in.
   *
   * A non-empty URL always wins over a previous media id: re-uploads must
   * create a new row instead of keeping the old storage_path (shop card fix).
   */
  async function resolveLandingMediaId(
    url: string,
    existingMediaId: string | null | undefined,
    altAr: string,
    altEn: string,
    options: {
      category: LandingMediaCategory;
      showInGallery: boolean;
      displayOrder?: number;
    },
  ): Promise<string | null> {
    const plan = planLandingMediaResolution(
      url,
      existingMediaId,
      mediaItems,
      options.showInGallery,
    );

    if (plan.kind === "reuse") {
      if (plan.needsGallerySync) {
        await updateMedia.mutateAsync({
          id: plan.id,
          updates: { show_in_gallery: options.showInGallery },
        });
      }
      return plan.id;
    }

    if (plan.kind === "keep") {
      return plan.id;
    }

    const created = await createMedia.mutateAsync({
      storage_path: plan.storagePath,
      mime_type: mimeTypeFromPath(plan.storagePath),
      category: options.category,
      alt_ar: altAr || "",
      alt_en: altEn || "",
      show_in_gallery: options.showInGallery,
      display_order: options.displayOrder ?? 0,
      is_active: true,
    });

    // Superseded rows keep is_active / show_in_gallery unless we retire them,
    // so both old and new would appear on the public gallery after a replace.
    if (plan.retireId && plan.retireId !== created.id) {
      await updateMedia.mutateAsync({
        id: plan.retireId,
        updates: { is_active: false, show_in_gallery: false },
      });
    }

    return created.id;
  }

  // Carousel Slide CRUD actions
  const onSaveSlide = async (data: any) => {
    if (!companyId) {
      toast.error(t("landingSettings.companySettingsNotLoaded"));
      return;
    }
    try {
      const mediaId = await resolveLandingMediaId(
        slideImageUrl,
        data.media_id || editingSlide?.media_id,
        data.title_ar || "",
        data.title_en || "",
        { category: "interior", showInGallery: slideImageInGallery },
      );
      if (!mediaId) {
        toast.error(t("landingSettings.uploadAnImagePasteA"));
        return;
      }

      // Mobile is optional: URL/upload wins, else dropdown id, else null (clears).
      // Mobile assets stay out of the gallery by default.
      let mobileMediaId: string | null = null;
      if (slideMobileImageUrl.trim()) {
        mobileMediaId = await resolveLandingMediaId(
          slideMobileImageUrl,
          data.mobile_media_id,
          data.title_ar || "",
          data.title_en || "",
          { category: "interior", showInGallery: false },
        );
      } else if (data.mobile_media_id && data.mobile_media_id !== "none") {
        mobileMediaId = data.mobile_media_id;
      }

      // Titles are optional on create — image-only drafts get placeholders
      // so staff can fill copy later. DB columns remain NOT NULL.
      const titleAr = String(data.title_ar ?? "").trim() || "شريحة جديدة";
      const titleEn = String(data.title_en ?? "").trim() || "New slide";

      const payload = {
        title_ar: titleAr,
        title_en: titleEn,
        description_ar: String(data.description_ar ?? "").trim() || null,
        description_en: String(data.description_en ?? "").trim() || null,
        cta_label_ar: String(data.cta_label_ar ?? "").trim() || null,
        cta_label_en: String(data.cta_label_en ?? "").trim() || null,
        cta_url: String(data.cta_url ?? "").trim() || null,
        display_order: Number(data.display_order) || 0,
        is_active: data.is_active === undefined ? true : Boolean(data.is_active),
        company_id: companyId,
        media_id: mediaId,
        mobile_media_id: mobileMediaId,
        carousel_key: editingSlide?.carousel_key || "main_midpoint",
      };

      if (editingSlide) {
        await updateSlide.mutateAsync({ id: editingSlide.id, updates: payload });
        toast.success(t("landingSettings.slideUpdated"));
      } else {
        await createSlide.mutateAsync(payload);
        toast.success(t("landingSettings.slideAdded"));
      }
      setSlideDialogOpen(false);
      setEditingSlide(null);
      setSlideImageUrl("");
      setSlideMobileImageUrl("");
      resetSlide();
    } catch (e: any) {
      toast.error(e.message || "Error");
    }
  };

  /** يعيد نموذج الشريحة وحالة صورها إلى الفراغ. */
  function resetSlideForm() {
    setEditingSlide(null);
    setSlideImageUrl("");
    setSlideMobileImageUrl("");
    setSlideImageInGallery(false);
    resetSlide();
  }

  /**
   * يملأ نموذج الشريحة بالقيم الحالية ويفتح حوار التعديل.
   *
   * Kept next to the form state it writes; the card menu only calls this.
   */
  function openSlideForEdit(slide: SlideRow) {
    const thumb = slide.media?.storage_path;
    setEditingSlide(slide);
    setSlideValue("title_ar", slide.title_ar);
    setSlideValue("title_en", slide.title_en);
    setSlideValue("description_ar", slide.description_ar || "");
    setSlideValue("description_en", slide.description_en || "");
    setSlideValue("cta_label_ar", slide.cta_label_ar || "");
    setSlideValue("cta_label_en", slide.cta_label_en || "");
    setSlideValue("cta_url", slide.cta_url || "");
    setSlideValue("display_order", slide.display_order ?? 0);
    setSlideValue("is_active", slide.is_active ?? true);
    setSlideValue("media_id", slide.media_id);
    setSlideValue("mobile_media_id", slide.mobile_media_id || "");
    setSlideImageUrl(thumb || "");
    setSlideMobileImageUrl(slide.mobile_media?.storage_path || "");
    setSlideImageInGallery(mediaShowInGallery(slide.media_id));
    setSlideDialogOpen(true);
  }

  /**
   * يحذف الشريحة بعد تأكيد أصلي — نفس `confirm()` الذي كان في صف الجدول.
   */
  function onDeleteSlide(id: string) {
    if (confirm(t("landingSettings.deleteSlide"))) deleteSlide.mutate(id);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row justify-between items-center">
        <div>
          <CardTitle>{t("landingSettings.midpointSliderSlides")}</CardTitle>
          <CardDescription>{t("landingSettings.manageSliderVisualSlidesWith")}</CardDescription>
        </div>
        <Dialog
          open={slideDialogOpen}
          onOpenChange={(open) => {
            setSlideDialogOpen(open);
            if (!open) resetSlideForm();
          }}
        >
          <DialogTrigger asChild>
            <Button
              size="sm"
              onClick={() => {
                resetSlideForm();
                setSlideValue("is_active", true);
                setSlideValue("display_order", (slides?.length || 0) + 1);
              }}
            >
              <Plus className="h-4 w-4 mr-1 ml-1" />
              {t("landingSettings.addSlide")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingSlide ? t("landingSettings.editSlide") : t("landingSettings.addSlide")}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSlideSubmit(onSaveSlide)} className="space-y-4">
              <div className="space-y-2">
                <Label>{t("landingSettings.titleArabicOptional")}</Label>
                <Input {...regSlide("title_ar")} placeholder={t("landingSettings.canAddLater")} />
              </div>
              <div className="space-y-2">
                <Label>{t("landingSettings.titleEnglishOptional")}</Label>
                <Input {...regSlide("title_en")} placeholder={t("landingSettings.canAddLater")} />
              </div>
              <div className="space-y-2">
                <Label>{t("landingSettings.descriptionArabic")}</Label>
                <Textarea {...regSlide("description_ar")} />
              </div>
              <div className="space-y-2">
                <Label>{t("landingSettings.descriptionEnglish")}</Label>
                <Textarea {...regSlide("description_en")} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>{t("landingSettings.ctaLabelArabic")}</Label>
                  <Input {...regSlide("cta_label_ar")} />
                </div>
                <div>
                  <Label>{t("landingSettings.ctaLabelEnglish")}</Label>
                  <Input {...regSlide("cta_label_en")} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t("landingSettings.ctaUrl")}</Label>
                <Input {...regSlide("cta_url")} placeholder="#shops" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t("landingSettings.displayOrder")}</Label>
                  <Input type="number" min={0} {...regSlide("display_order")} placeholder="0" />
                </div>
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <Label htmlFor="slide-is-active">{t("landingSettings.active")}</Label>
                  <Switch
                    id="slide-is-active"
                    checked={!!slideIsActive}
                    onCheckedChange={(checked) => setSlideValue("is_active", checked)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t("landingSettings.slideImageUploadOrUrl")}</Label>
                <ImageSourceInput
                  value={slideImageUrl}
                  onChange={setSlideImageUrl}
                  bucket="landing"
                  canUpload={canUploadLandingImages}
                  uploadHint={landingUploadHint}
                  folder="carousel"
                  maxDimension={1920}
                  placeholder={t("landingSettings.imageUrlOrUploadA")}
                />
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <Label htmlFor="slide-image-gallery" className="text-sm font-normal">
                    {t("landingSettings.showSlideImageInGallery")}
                  </Label>
                  <Switch
                    id="slide-image-gallery"
                    checked={slideImageInGallery}
                    onCheckedChange={setSlideImageInGallery}
                  />
                </div>
                <Select onValueChange={(val) => setSlideValue("media_id", val)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("landingSettings.orPickAnExistingAsset")} />
                  </SelectTrigger>
                  <SelectContent>
                    {mediaItems?.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.alt_en || m.storage_path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("landingSettings.mobileImageOptional")}</Label>
                <ImageSourceInput
                  value={slideMobileImageUrl}
                  onChange={setSlideMobileImageUrl}
                  bucket="landing"
                  canUpload={canUploadLandingImages}
                  uploadHint={landingUploadHint}
                  folder="carousel/mobile"
                  maxDimension={1080}
                  placeholder={t("landingSettings.mobileImageUrlOrUpload")}
                />
                <Select
                  onValueChange={(val) =>
                    setSlideValue("mobile_media_id", val === "none" ? "" : val)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("landingSettings.orPickMobileAsset")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("landingSettings.none")}</SelectItem>
                    {mediaItems?.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.alt_en || m.storage_path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="submit">{t("common.save")}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        <SlidesTable slides={slides} onEditSlide={openSlideForEdit} onDeleteSlide={onDeleteSlide} />
      </CardContent>
    </Card>
  );
}
