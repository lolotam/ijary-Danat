import type { FieldValues, Path, UseFormReturn } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";

/**
 * الحقول المشتركة القابلة للتعديل من المستأجر والإدارة — عرض فقط.
 *
 * PRESENTATIONAL ONLY: no mutation, no fetching, no privileged values.
 * Takes the form object and renders inputs for the shared, tenant-editable fields.
 * الحقول الإدارية المحظورة يجب ألا تظهر هنا أبداً.
 */

export interface ShopDetailsFormValues {
  name_original: string;
  name_ar: string;
  name_en: string;
  phone: string;
  opening_hours: string;
  website_url: string;
  instagram_url: string;
  description_ar: string;
  description_en: string;
}

/**
 * Generic over the caller's full form, constrained to forms that at least carry
 * the shared fields.
 *
 * `UseFormReturn<T>` is invariant, so a plain
 * `UseFormReturn<ShopDetailsFormValues>` prop cannot accept the admin dialog's
 * wider form — which is why the first attempt reached for a cast. The generic
 * is what makes both callers type-check honestly: the tenant passes exactly the
 * shared fields, the admin passes those plus its privileged ones, and this
 * component can still only touch the shared ones.
 */
export interface ShopDetailsFieldsProps<T extends FieldValues & ShopDetailsFormValues> {
  form: UseFormReturn<T>;
}

export function ShopDetailsFields<T extends FieldValues & ShopDetailsFormValues>({
  form,
}: ShopDetailsFieldsProps<T>) {
  const { t } = useI18n();
  // `Path<T>` cannot be narrowed from the constraint alone, so each shared field
  // is named through this helper rather than repeating an inline assertion.
  const field = (name: keyof ShopDetailsFormValues) => name as Path<T>;
  const { register } = form;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <Label required>{t("shopDetails.originalName")}</Label>
        <Input {...register(field("name_original"), { required: true })} />
      </div>
      <div>
        <Label required>{t("shopDetails.arabicName")}</Label>
        <Input {...register(field("name_ar"), { required: true })} />
      </div>
      <div>
        <Label required>{t("shopDetails.englishName")}</Label>
        <Input {...register(field("name_en"), { required: true })} />
      </div>
      <div>
        <Label>{t("portal.shop.phone")}</Label>
        <Input {...register(field("phone"))} />
      </div>
      <div>
        <Label>{t("portal.shop.openingHours")}</Label>
        <Input {...register(field("opening_hours"))} placeholder="08:00 AM - 10:00 PM" />
      </div>
      <div>
        <Label>{t("portal.shop.websiteUrl")}</Label>
        <Input {...register(field("website_url"))} placeholder="https://example.com" dir="ltr" />
      </div>
      <div>
        <Label>{t("portal.shop.instagramUrl")}</Label>
        <Input
          {...register(field("instagram_url"))}
          placeholder="https://instagram.com/..."
          dir="ltr"
        />
      </div>
      <div className="md:col-span-2">
        <Label>{t("portal.shop.descriptionAr")}</Label>
        <Textarea {...register(field("description_ar"))} rows={2} />
      </div>
      <div className="md:col-span-2">
        <Label>{t("portal.shop.descriptionEn")}</Label>
        <Textarea {...register(field("description_en"))} rows={2} />
      </div>
    </div>
  );
}
