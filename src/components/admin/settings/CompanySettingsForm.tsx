import { useState } from "react";
import { useFormContext, type FieldPath, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";

import { AnnouncementSettingsCard } from "@/components/admin/AnnouncementSettingsCard";
import { PortalPaymentMethodsCard } from "@/components/admin/PortalPaymentMethodsCard";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/i18n/provider";
import { STORAGE_UPLOAD_MAX_BYTES } from "@/lib/uploadLimits";
import type { SettingsFormValues } from "./companySettingsSchema";

interface SettingsFieldProps {
  name: FieldPath<SettingsFormValues>;
  label: string;
  multiline?: boolean;
  type?: string;
  /** Renders the red asterisk. */
  required?: boolean;
}

function SettingsField({
  name,
  label,
  multiline = false,
  type = "text",
  required,
}: SettingsFieldProps) {
  const { control } = useFormContext<SettingsFormValues>();

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel required={required}>{label}</FormLabel>
          <FormControl>
            {multiline ? (
              <Textarea {...field} value={String(field.value ?? "")} rows={3} />
            ) : (
              <Input
                {...field}
                dir={type === "tel" ? "ltr" : undefined}
                inputMode={type === "tel" ? "tel" : undefined}
                value={String(field.value ?? "")}
                type={type}
              />
            )}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * URL field with an optional file upload: uploading stores the file in the
 * public `branding` bucket and writes the resulting public URL into the same
 * form field, so both "paste a URL" and "upload a file" end in company row
 * columns that the whole app (admin, portal, landing, favicon) reads.
 */
function BrandingAssetField({
  name,
  label,
}: {
  name: "logo_url" | "favicon_url" | "bank_logo_url";
  label: string;
}) {
  const { t } = useI18n();
  const { control, setValue, watch } = useFormContext<SettingsFormValues>();
  const [uploading, setUploading] = useState(false);
  const currentUrl = watch(name);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      if (file.size > STORAGE_UPLOAD_MAX_BYTES || !file.type.startsWith("image/")) {
        throw new Error(t("settings.brandingFileInvalid"));
      }
      const extension =
        file.name
          .split(".")
          .pop()
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "png";
      const folder =
        name === "favicon_url" ? "favicon" : name === "bank_logo_url" ? "bank-logo" : "logo";
      const path = `${folder}/${Date.now()}.${extension}`;
      const upload = await supabase.storage
        .from("branding")
        .upload(path, file, { upsert: true, cacheControl: "3600" });
      if (upload.error) throw upload.error;
      const { data } = supabase.storage.from("branding").getPublicUrl(path);
      setValue(name, data.publicUrl, { shouldDirty: true, shouldValidate: true });
      toast.success(t("settings.brandingUploaded"));
    } catch (error) {
      toast.error(t("settings.saveError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <div className="flex items-center gap-2">
            {currentUrl ? (
              <img
                src={currentUrl}
                alt={label}
                className="size-9 shrink-0 rounded border object-contain"
              />
            ) : null}
            <FormControl>
              <Input
                {...field}
                value={String(field.value ?? "")}
                dir="ltr"
                placeholder="https://…"
              />
            </FormControl>
            <Button asChild size="sm" variant="outline" disabled={uploading}>
              <label className="cursor-pointer">
                {uploading ? t("common.loading") : t("settings.brandingUpload")}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) uploadFile(file);
                    event.target.value = "";
                  }}
                />
              </label>
            </Button>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function IdentityFields() {
  const { t } = useI18n();
  return (
    <>
      <SettingsField required name="name_ar" label={t("settings.nameAr")} />
      <SettingsField required name="name_en" label={t("settings.nameEn")} />
      <BrandingAssetField name="logo_url" label={t("settings.logoUrl")} />
      <BrandingAssetField name="favicon_url" label={t("settings.faviconUrl")} />
      <SettingsField name="address_ar" label={t("settings.addressAr")} multiline />
      <SettingsField name="address_en" label={t("settings.addressEn")} multiline />
      <SettingsField name="map_url" label={t("settings.mapUrl")} />
    </>
  );
}

function ContactFields() {
  const { t } = useI18n();
  return (
    <>
      <SettingsField name="email" label={t("settings.email")} type="email" />
      <SettingsField name="phone" label={t("settings.phone")} type="tel" />
      <SettingsField name="whatsapp" label={t("settings.whatsapp")} type="tel" />
      <SettingsField name="facebook_url" label={t("settings.facebookUrl")} />
      <SettingsField name="instagram_url" label={t("settings.instagramUrl")} />
    </>
  );
}

function FinancialAndBrandFields() {
  const { t } = useI18n();
  return (
    <>
      <SettingsField name="iban" label={t("settings.iban")} />
      <SettingsField name="bank_name" label={t("settings.bankName")} />
      <BrandingAssetField name="bank_logo_url" label={t("settings.bankLogoUrl")} />
      <SettingsField name="invoice_footer_ar" label={t("settings.invoiceFooterAr")} multiline />
      <SettingsField name="invoice_footer_en" label={t("settings.invoiceFooterEn")} multiline />
      <SettingsField name="brand_primary" label={t("settings.brandPrimary")} />
      <SettingsField name="brand_accent" label={t("settings.brandAccent")} />
    </>
  );
}

function DefaultLocaleField() {
  const { t } = useI18n();
  const { control } = useFormContext<SettingsFormValues>();
  return (
    <FormField
      control={control}
      name="default_locale"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t("settings.defaultLocale")}</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="ar">العربية</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * يعرض نموذج إعدادات الشركة بكل أقسامه وزر الحفظ.
 */
export function SettingsForm({
  form,
  isPending,
  submitSettings,
}: {
  form: UseFormReturn<SettingsFormValues>;
  isPending: boolean;
  submitSettings: (values: SettingsFormValues) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submitSettings)} className="space-y-8">
        <div className="grid gap-5 md:grid-cols-2">
          <IdentityFields />
          <ContactFields />
          <FinancialAndBrandFields />
          <DefaultLocaleField />
          <SettingsField name="timezone" label={t("settings.timezone")} />
          <SettingsField name="currency" label={t("settings.currency")} />
          <AnnouncementSettingsCard />
          <PortalPaymentMethodsCard />
        </div>
        <Button type="submit" disabled={isPending}>
          {isPending ? t("common.loading") : t("common.save")}
        </Button>
      </form>
    </Form>
  );
}
