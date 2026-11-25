import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { ImageSourceInput } from "@/components/admin/ImageSourceInput";
import { BrandContractsField } from "@/components/admin/landing-page/BrandContractsField";
import { ShopDetailsFields, type ShopDetailsFormValues } from "@/components/shop/ShopDetailsFields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useActiveContractOptions,
  useBrandContractLinks,
  useCreateBrand,
  useDeleteBrand,
  useLandingBrands,
  useLandingMedia,
  useCreateLandingMedia,
  useUpdateLandingMedia,
  useSaveBrandContracts,
  useUpdateBrand,
  type LandingMediaCategory,
} from "@/hooks/useLandingSettings";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/i18n/provider";
import { mimeTypeFromPath } from "@/lib/imageCompression";
import { planLandingMediaResolution } from "@/lib/resolveLandingMedia";
import { SHOP_IMAGE_FIELDS } from "@/lib/shopImageFields";
import { ShopsTable } from "@/components/admin/landing-page/ShopsTable";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus } from "lucide-react";

/**
 * يحدّد العقار الذي تتبعه محلات صفحة الهبوط، اعتماداً على المحلات الموجودة فعلاً
 * لا على كود عقار مكتوب داخل الشيفرة.
 *
 * Property codes are renameable business identifiers, not keys — the Jahra
 * properties get renumbered when the business renumbers them. A hardcoded
 * `.eq("code", "PROP-JAHRA")` does not fail loudly when that happens; it returns
 * null, and the previous fallback then pushed the literal string `"PROP-JAHRA"`
 * into `commercial_brands.property_id`, a uuid column. Reading the property off a
 * sibling brand is code-agnostic and survives any future renumbering.
 */
async function resolveLandingPropertyId(
  loadedBrands: Array<{ property_id?: string | null }> | undefined,
): Promise<string | null> {
  const fromLoadedBrands = loadedBrands?.[0]?.property_id;
  if (fromLoadedBrands) return fromLoadedBrands;

  const { data: anyBrand, error } = await supabase
    .from("commercial_brands")
    .select("property_id")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return anyBrand?.property_id ?? null;
}

/**
 * قسم المحلات في إعدادات صفحة الهبوط — نفس سلوك الحفظ القديم دون تغيير.
 *
 * تم فصله من `src/routes/admin.settings.landing-page.tsx` (كان 1746 سطراً)
 * حتى يبقى الملف تحت سقف 500-600 سطراً. كل حقل وكل ترتيب وكل كتابة
 * بقيت كما هي؛ الفارق الوحيد أن الحقول المشتركة تُعرض عبر
 * `ShopDetailsFields` العرضي فقط، بينما تبقى الضوابط الإدارية هنا.
 */

export function AdminShopsSection() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const canView =
    !permissions.isLoading &&
    permissions.canAny([PERMISSIONS.LANDING_PAGE_READ, PERMISSIONS.LANDING_PAGE_UPDATE]);
  const canUploadLandingImages = permissions.can(PERMISSIONS.LANDING_PAGE_UPDATE);
  const landingUploadHint = canUploadLandingImages
    ? undefined
    : t("brandDialog.uploadingLandingImagesRequiresAn");

  const { data: brands } = useLandingBrands(canView);
  const { data: mediaItems } = useLandingMedia(undefined, canView);
  const { data: contractOptions } = useActiveContractOptions(canView);
  const brandContractLinks = useBrandContractLinks(canView);
  const contractIdsByBrand = brandContractLinks.data ?? new Map<string, string[]>();
  const contractLabelById = new Map(
    (contractOptions ?? []).map((c) => [c.id, `${c.code} — ${c.tenantName}`]),
  );

  const createBrand = useCreateBrand();
  const updateBrand = useUpdateBrand();
  const deleteBrand = useDeleteBrand();
  const createMedia = useCreateLandingMedia();
  const updateMedia = useUpdateLandingMedia();
  const saveBrandContracts = useSaveBrandContracts();

  const [brandDialogOpen, setBrandDialogOpen] = useState(false);
  const [editingBrand, setEditingBrand] = useState<any>(null);
  const [brandLogoUrl, setBrandLogoUrl] = useState("");
  const [brandCardUrl, setBrandCardUrl] = useState("");
  const [brandLogoInGallery, setBrandLogoInGallery] = useState(false);
  const [brandCardInGallery, setBrandCardInGallery] = useState(false);
  const [brandContractIds, setBrandContractIds] = useState<string[]>([]);
  const [brandContractsKnown, setBrandContractsKnown] = useState(false);

  const brandForm = useForm<
    ShopDetailsFormValues & {
      slug: string;
      is_featured: boolean;
      show_in_brands_marquee: boolean;
      show_in_shop_explorer: boolean;
      logo_media_id: string | null;
      cover_media_id: string | null;
    }
  >();
  const regBrand = brandForm.register;
  const handleBrandSubmit = brandForm.handleSubmit;
  const resetBrand = brandForm.reset;
  const setBrandValue = brandForm.setValue;
  const watchBrand = brandForm.watch;
  const brandShowInMarquee = watchBrand("show_in_brands_marquee");
  const brandShowInExplorer = watchBrand("show_in_shop_explorer");

  /**
   * هل هذا الأصل معروض في معرض الصفحة الرئيسية؟
   *
   * Read from the already-loaded media list rather than re-queried: the dialog
   * needs it only to prefill the gallery switch, and the list is in hand.
   */
  function mediaShowInGallery(id: string | null | undefined): boolean {
    if (!id) return false;
    return mediaItems?.find((m) => m.id === id)?.show_in_gallery === true;
  }

  /**
   * يحوّل رابطاً مكتوباً أو مرفوعاً إلى صف في `landing_media` ويعيد معرّفه.
   *
   * A pasted or uploaded URL wins over a picked existing asset, and is
   * registered in `landing_media` so it becomes reusable elsewhere instead of
   * living only on this shop. Gallery opt-in is per image, which is why the
   * caller passes it rather than this deciding.
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
    if (plan.kind === "keep") return plan.id;
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
    if (plan.retireId && plan.retireId !== created.id) {
      await updateMedia.mutateAsync({
        id: plan.retireId,
        updates: { is_active: false, show_in_gallery: false },
      });
    }
    return created.id;
  }

  /**
   * يعيد نموذج المحل إلى حالته الفارغة قبل إضافة محل جديد.
   *
   * The two visibility switches are set to true explicitly after `reset()`:
   * they default ON for a new shop, and `reset()` alone would leave them
   * undefined, which the controlled `Switch` renders as off.
   */
  function resetBrandForm() {
    setEditingBrand(null);
    setBrandLogoUrl("");
    setBrandCardUrl("");
    setBrandLogoInGallery(false);
    setBrandCardInGallery(false);
    setBrandContractIds([]);
    setBrandContractsKnown(false);
    resetBrand();
    setBrandValue("show_in_brands_marquee", true);
    setBrandValue("show_in_shop_explorer", true);
  }

  const onSaveBrand = async (data: any) => {
    try {
      let logoMediaId: string | null = data.logo_media_id || null;
      if (brandLogoUrl.trim() || logoMediaId) {
        logoMediaId = await resolveLandingMediaId(
          brandLogoUrl,
          logoMediaId || editingBrand?.logo_media_id,
          data.name_ar || "",
          data.name_en || "",
          { category: "logo", showInGallery: brandLogoInGallery },
        );
      }
      let coverMediaId: string | null = data.cover_media_id || null;
      if (brandCardUrl.trim() || coverMediaId) {
        coverMediaId = await resolveLandingMediaId(
          brandCardUrl,
          coverMediaId || editingBrand?.cover_media_id,
          data.name_ar || "",
          data.name_en || "",
          { category: "shops", showInGallery: brandCardInGallery },
        );
      }
      const payload = {
        name_original: data.name_original,
        name_ar: data.name_ar,
        name_en: data.name_en,
        slug: data.slug || data.name_en.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        description_ar: data.description_ar || null,
        description_en: data.description_en || null,
        phone: data.phone || null,
        website_url: data.website_url || null,
        instagram_url: data.instagram_url || null,
        is_featured: !!data.is_featured,
        is_active: true,
        show_in_brands_marquee: data.show_in_brands_marquee !== false,
        show_in_shop_explorer: data.show_in_shop_explorer !== false,
        opening_hours_json: { daily: data.opening_hours || "08:00 AM - 10:00 PM" },
        logo_media_id: logoMediaId,
        cover_media_id: coverMediaId,
      };
      if (editingBrand) {
        await updateBrand.mutateAsync({ id: editingBrand.id, updates: payload });
        if (brandContractsKnown) {
          await saveBrandContracts.mutateAsync({
            brandId: editingBrand.id,
            contractIds: brandContractIds,
          });
        } else {
          toast.warning(t("brandDialog.theShopSContractsCould"));
        }
        toast.success(t("brandDialog.brandUpdatedSuccessfully"));
      } else {
        const landingPropertyId = await resolveLandingPropertyId(brands);
        if (!landingPropertyId) {
          toast.error(t("brandDialog.couldNotDetermineTheLanding"));
          return;
        }
        const created = await createBrand.mutateAsync({
          ...payload,
          property_id: landingPropertyId,
        });
        if (created?.id && brandContractIds.length) {
          await saveBrandContracts.mutateAsync({
            brandId: created.id,
            contractIds: brandContractIds,
          });
        }
        toast.success(t("brandDialog.brandAddedSuccessfully"));
      }
      setBrandDialogOpen(false);
      resetBrandForm();
    } catch (e: any) {
      toast.error(e.message || "Error");
    }
  };

  const onDeleteBrand = async (id: string) => {
    if (!confirm(t("brandDialog.areYouSureYouWant"))) return;
    try {
      await deleteBrand.mutateAsync(id);
      toast.success(t("brandDialog.brandDeleted"));
    } catch (e) {
      toast.error(t("brandDialog.deletionFailed"));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row justify-between items-center">
        <div>
          <CardTitle>{t("brandDialog.storeDirectoryBrands")}</CardTitle>
          <CardDescription>{t("brandDialog.manageBrandTenantLogsStorefront")}</CardDescription>
        </div>
        <Dialog
          open={brandDialogOpen}
          onOpenChange={(open) => {
            setBrandDialogOpen(open);
            if (!open) resetBrandForm();
          }}
        >
          <Button size="sm" onClick={() => setBrandDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1 ml-1" />
            {t("brandDialog.addStore")}
          </Button>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingBrand ? t("brandDialog.editStore") : t("brandDialog.addNewStore")}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleBrandSubmit(onSaveBrand)} className="space-y-4">
              <ShopDetailsFields form={brandForm} />
              <div>
                <Label>{t("brandDialog.urlSlug")}</Label>
                <Input {...regBrand("slug")} placeholder="e.g. arabica-coffee" />
              </div>
              <div className="md:col-span-2 space-y-2">
                <Label className="flex flex-wrap items-center gap-2">
                  {t("brandDialog.storeLogoBrandsCarouselUpload")}
                  <span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    {SHOP_IMAGE_FIELDS.logo.ratioLabel}
                  </span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("brandDialog.shownInBrandsAtDanat")}
                </p>
                <ImageSourceInput
                  value={brandLogoUrl}
                  onChange={setBrandLogoUrl}
                  bucket="landing"
                  canUpload={canUploadLandingImages}
                  uploadHint={landingUploadHint}
                  folder="shops/logos"
                  maxDimension={512}
                  placeholder={t("brandDialog.imageUrlOrUploadA")}
                />
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <Label htmlFor="brand-logo-gallery" className="text-sm font-normal">
                    {t("brandDialog.showLogoInGallery")}
                  </Label>
                  <Switch
                    id="brand-logo-gallery"
                    checked={brandLogoInGallery}
                    onCheckedChange={setBrandLogoInGallery}
                  />
                </div>
                <Select onValueChange={(val) => setBrandValue("logo_media_id", val)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("brandDialog.orPickAnExistingAsset")} />
                  </SelectTrigger>
                  <SelectContent>
                    {mediaItems
                      ?.filter((m) => m.category === "logo")
                      .map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.alt_en || m.storage_path}
                        </SelectItem>
                      ))}
                    {mediaItems
                      ?.filter((m) => m.category !== "logo")
                      .map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.alt_en || m.storage_path}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-2 space-y-2">
                <Label className="flex flex-wrap items-center gap-2">
                  {t("brandDialog.shopCardImageStoreDirectory")}
                  <span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    {SHOP_IMAGE_FIELDS.cover.ratioLabel}
                  </span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("brandDialog.shownOnExploreOurShops")}
                </p>
                <ImageSourceInput
                  value={brandCardUrl}
                  onChange={setBrandCardUrl}
                  bucket="landing"
                  canUpload={canUploadLandingImages}
                  uploadHint={landingUploadHint}
                  folder="shops/cards"
                  placeholder={t("brandDialog.imageUrlOrUploadA")}
                />
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <Label htmlFor="brand-card-gallery" className="text-sm font-normal">
                    {t("brandDialog.showCardImageInGallery")}
                  </Label>
                  <Switch
                    id="brand-card-gallery"
                    checked={brandCardInGallery}
                    onCheckedChange={setBrandCardInGallery}
                  />
                </div>
                <Select onValueChange={(val) => setBrandValue("cover_media_id", val)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("brandDialog.orPickAnExistingAsset")} />
                  </SelectTrigger>
                  <SelectContent>
                    {mediaItems
                      ?.filter((m) => m.category === "shops")
                      .map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.alt_en || m.storage_path}
                        </SelectItem>
                      ))}
                    {mediaItems
                      ?.filter((m) => m.category !== "shops")
                      .map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.alt_en || m.storage_path}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-2">
                <BrandContractsField
                  options={contractOptions}
                  selectedIds={brandContractIds}
                  onChange={setBrandContractIds}
                  labels={{
                    heading: t("brandDialog.activeContractsOptional"),
                    empty: t("brandDialog.noActiveContracts"),
                    // English pluralises and Arabic does not, so the count
                    // picks between two keys rather than building the noun.
                    selectedCount: (count) =>
                      t(
                        count === 1
                          ? "brandDialog.contractSelected"
                          : "brandDialog.contractsSelected",
                      ).replace("{count}", String(count)),
                    hiddenCount: (count) =>
                      t("brandDialog.onInactiveContracts").replace("{count}", String(count)),
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_featured"
                  {...regBrand("is_featured")}
                  className="h-4 w-4"
                />
                <Label htmlFor="is_featured">{t("brandDialog.featuredOnFrontpage")}</Label>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                <Label htmlFor="brand-show-in-marquee" className="text-sm font-normal">
                  {t("admin.landing.shop.showInMarquee")}
                </Label>
                <Switch
                  id="brand-show-in-marquee"
                  checked={brandShowInMarquee !== false}
                  onCheckedChange={(checked) => setBrandValue("show_in_brands_marquee", checked)}
                />
              </div>
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                <Label htmlFor="brand-show-in-explorer" className="text-sm font-normal">
                  {t("admin.landing.shop.showInExplorer")}
                </Label>
                <Switch
                  id="brand-show-in-explorer"
                  checked={brandShowInExplorer !== false}
                  onCheckedChange={(checked) => setBrandValue("show_in_shop_explorer", checked)}
                />
              </div>
              <DialogFooter>
                <Button type="submit">{t("common.save")}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        <ShopsTable
          brands={brands}
          contractLabelById={contractLabelById}
          contractIdsByBrand={contractIdsByBrand}
          onEditBrand={(brand: any) => {
            setEditingBrand(brand);
            setBrandValue("name_original", brand.name_original);
            setBrandValue("name_ar", brand.name_ar);
            setBrandValue("name_en", brand.name_en);
            setBrandValue("slug", brand.slug);
            setBrandValue("phone", brand.phone || "");
            setBrandValue("opening_hours", (brand.opening_hours_json as any)?.daily || "");
            setBrandValue("website_url", brand.website_url || "");
            setBrandValue("instagram_url", brand.instagram_url || "");
            setBrandValue("description_ar", brand.description_ar || "");
            setBrandValue("description_en", brand.description_en || "");
            setBrandValue("is_featured", brand.is_featured);
            setBrandValue("show_in_brands_marquee", brand.show_in_brands_marquee ?? true);
            setBrandValue("show_in_shop_explorer", brand.show_in_shop_explorer ?? true);
            setBrandValue("logo_media_id", brand.logo_media_id);
            setBrandValue("cover_media_id", brand.cover_media_id);
            setBrandLogoUrl((brand as any).logo?.storage_path || "");
            setBrandCardUrl((brand as any).cover?.storage_path || "");
            setBrandLogoInGallery(mediaShowInGallery(brand.logo_media_id));
            setBrandCardInGallery(mediaShowInGallery(brand.cover_media_id));
            setBrandContractIds(contractIdsByBrand.get(brand.id) ?? []);
            setBrandContractsKnown(brandContractLinks.isSuccess);
            setBrandDialogOpen(true);
          }}
          onDeleteBrand={onDeleteBrand}
        />
      </CardContent>
    </Card>
  );
}
