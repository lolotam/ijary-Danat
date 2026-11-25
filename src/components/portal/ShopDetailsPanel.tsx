import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ShopDetailsFields, type ShopDetailsFormValues } from "@/components/shop/ShopDetailsFields";
import { ShopImageField } from "@/components/portal/ShopImageField";
import { usePortalContractSelection } from "@/hooks/usePortalContractSelection";
import { usePortalIdentity } from "@/hooks/usePortalData";
import { useShopDetails, useSaveShopDetails } from "@/hooks/useShopDetails";
import { useShopImageUpload } from "@/hooks/useShopImageUpload";
import { useI18n } from "@/i18n/provider";
import { isValidShopUrl } from "@/lib/shopValidation";

/**
 * لوحة متجري في بوابة المستأجر — يحرر المستأجر واجهة محله بنفسه.
 *
 * يقرأ عبر `shop_details_for_tenant` (يرى المعطّل أيضاً) ويحفظ عبر
 * `save_shop_details_as_tenant` بقائمة بيضاء. الحقول غير المسموحة غير
 * موجودة في الواجهة أصلاً، لا مخفية بـ CSS.
 *
 * الصور: يضغطها العميل بحد 512 ثم يرفعها عبر دالة الخادم التي تكتب بـ
 * service-role في مسار محصور بالمستأجر وتنشئ صف landing_media. الحذف يعني
 * تصفير العمود فقط — لا يُحذف الكائن من التخزين حتى لا ينكسر استخدام
 * محل آخر لنفس الوسائط.
 */
export function ShopDetailsPanel() {
  const { t, dir } = useI18n();
  // Scoped to the contract the portal is currently showing, so a tenant with a
  // shop on each of two leases edits the one they selected.
  const identity = usePortalIdentity();
  const { contractId } = usePortalContractSelection(identity.data?.tenant?.id ?? null);
  const query = useShopDetails(contractId);
  const save = useSaveShopDetails();
  const brand = query.data?.[0] ?? null;

  const form = useForm<ShopDetailsFormValues>({
    defaultValues: {
      name_original: "",
      name_ar: "",
      name_en: "",
      phone: "",
      opening_hours: "",
      website_url: "",
      instagram_url: "",
      description_ar: "",
      description_en: "",
    },
  });

  const logo = useShopImageUpload("logo", brand?.id);
  const cover = useShopImageUpload("cover", brand?.id);
  const resetLogo = logo.reset;
  const resetCover = cover.reset;

  useEffect(() => {
    if (!brand) return;
    form.reset({
      name_original: brand.name_original ?? "",
      name_ar: brand.name_ar ?? "",
      name_en: brand.name_en ?? "",
      phone: brand.phone ?? "",
      opening_hours: brand.opening_hours ?? "",
      website_url: brand.website_url ?? "",
      instagram_url: brand.instagram_url ?? "",
      description_ar: brand.description_ar ?? "",
      description_en: brand.description_en ?? "",
    });
    resetLogo(brand.logo_media_id, brand.logo_url);
    resetCover(brand.cover_media_id, brand.cover_url);
  }, [brand, form, resetLogo, resetCover]);

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (query.isError) {
    return <p className="text-sm text-destructive">{t("common.error")}</p>;
  }
  if (!brand) {
    return (
      <Card dir={dir}>
        <CardHeader>
          <CardTitle>{t("portal.shop.emptyTitle")}</CardTitle>
          <CardDescription>{t("portal.shop.emptyDescription")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    if (!isValidShopUrl(values.website_url)) {
      toast.error(t("portal.shop.urlInvalid"));
      return;
    }
    if (!isValidShopUrl(values.instagram_url)) {
      toast.error(t("portal.shop.urlInvalid"));
      return;
    }
    try {
      await save.mutateAsync({
        brandId: brand.id,
        name_original: values.name_original,
        name_ar: values.name_ar,
        name_en: values.name_en,
        phone: values.phone.trim() || null,
        opening_hours: values.opening_hours.trim() || null,
        website_url: values.website_url.trim() || null,
        instagram_url: values.instagram_url.trim() || null,
        description_ar: values.description_ar.trim() || null,
        description_en: values.description_en.trim() || null,
        logo_media_id: logo.mediaId,
        cover_media_id: cover.mediaId,
        expectedUpdatedAt: brand.updated_at,
      });
      toast.success(t("portal.shop.saved"));
    } catch (e: any) {
      const msg = e?.message ?? "";
      if (msg.includes("40001") || msg.toLowerCase().includes("concurrent")) {
        toast.error(t("portal.shop.concurrentError"));
      } else if (msg.toLowerCase().includes("http")) {
        toast.error(t("portal.shop.urlInvalid"));
      } else {
        toast.error(e?.message || t("portal.shop.saveError"));
      }
    }
  });

  return (
    <Card dir={dir}>
      <CardHeader>
        <CardTitle>{t("portal.shop.title")}</CardTitle>
        <CardDescription>{t("portal.shop.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-6">
          <ShopDetailsFields form={form} />

          <div className="grid gap-6 md:grid-cols-2">
            <ShopImageField kind="logo" image={logo} />
            <ShopImageField kind="cover" image={cover} />
          </div>

          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t("portal.shop.saving") : t("common.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
