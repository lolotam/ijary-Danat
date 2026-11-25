import type { UseFormReturn } from "react-hook-form";

import { FormSelectField, FormTextField } from "@/components/admin/Phase2FormFields";
import { PropertyImageField } from "@/components/admin/properties/PropertyImageField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { useI18n } from "@/i18n/provider";
import { type PropertyFormValues } from "@/lib/propertyForm";

/**
 * حوار إضافة عقار أو تعديله.
 *
 * Presentational: the page owns the form, the property being edited and the
 * save — the dialog stays open after a save, and the next Save must update
 * the property just created.
 */
export function PropertyFormDialog({
  open,
  onOpenChange,
  form,
  editingCode,
  typeOptions,
  statusOptions,
  onSave,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: UseFormReturn<PropertyFormValues>;
  /** رمز العقار المحرَّر، أو null لعقار جديد. */
  editingCode: string | null;
  typeOptions: Array<{ value: string; label: string }>;
  statusOptions: Array<{ value: string; label: string }>;
  onSave: (values: PropertyFormValues) => Promise<void>;
  pending: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingCode !== null ? t("properties.edit") : t("properties.add")}
          </DialogTitle>
          <DialogDescription>{editingCode ?? t("phase2.codeGenerated")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit(onSave)}>
            <FormTextField
              required
              control={form.control}
              name="name_ar"
              label={t("common.nameAr")}
            />
            <FormTextField control={form.control} name="name_en" label={t("common.nameEn")} />
            <FormTextField control={form.control} name="paci_no" label={t("properties.paciNo")} />
            <FormSelectField
              required
              control={form.control}
              name="type"
              label={t("common.type")}
              options={typeOptions}
            />
            <FormSelectField
              required
              control={form.control}
              name="status"
              label={t("common.status")}
              options={statusOptions}
            />
            <FormTextField
              control={form.control}
              name="area"
              type="number"
              label={t("common.area")}
            />
            <FormTextField
              control={form.control}
              name="floor_count"
              type="number"
              label={t("properties.floorCount")}
            />
            <FormTextField
              control={form.control}
              name="unit_count"
              type="number"
              label={t("properties.unitCount")}
            />
            <FormTextField
              control={form.control}
              name="location_url"
              label={t("common.locationUrl")}
            />
            <FormTextField control={form.control} name="address_ar" label={t("common.addressAr")} />
            <FormTextField control={form.control} name="address_en" label={t("common.addressEn")} />
            <PropertyImageField form={form} />
            <FormTextField
              control={form.control}
              name="description_ar"
              label={t("common.descriptionAr")}
              multiline
            />
            <FormTextField
              control={form.control}
              name="description_en"
              label={t("common.descriptionEn")}
              multiline
            />
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
