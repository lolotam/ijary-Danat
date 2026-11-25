import type { UseFormReturn } from "react-hook-form";

import { ImageSourceInput } from "@/components/admin/ImageSourceInput";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { PropertyFormValues } from "@/lib/propertyForm";

/** يحافظ على تتبّع صورة العقار والتحقق منها داخل النموذج عند اختيار رابط أو رفع ملف. */
export function PropertyImageField({ form }: { form: UseFormReturn<PropertyFormValues> }) {
  const { t } = useI18n();
  const imageUrl = form.watch("image_url");
  return (
    <div className="sm:col-span-2 space-y-2">
      <Label>{t("common.imageUrl")}</Label>
      <ImageSourceInput
        value={imageUrl}
        onChange={(url) =>
          form.setValue("image_url", url, { shouldDirty: true, shouldValidate: true })
        }
        bucket="property-images"
        folder="properties"
      />
    </div>
  );
}
