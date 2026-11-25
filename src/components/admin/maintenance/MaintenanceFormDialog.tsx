import type { UseFormReturn } from "react-hook-form";

import { FormSelectField, FormTextField } from "@/components/admin/Phase2FormFields";
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
import { sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";
import type { Building } from "@/hooks/useBuildings";
import type { Property } from "@/hooks/useProperties";
import type { Unit } from "@/hooks/useUnits";
import {
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  type MaintenanceFormValues,
} from "@/lib/maintenanceForm";

/**
 * حوار إضافة طلب صيانة أو تعديله.
 *
 * Presentational: the page owns the form, the row being edited and the save,
 * because the dialog stays open after a save and the next Save must update
 * the request just filed — only the page knows that id. `buildings` and
 * `units` arrive already narrowed to the chosen property (and building).
 */
export function MaintenanceFormDialog({
  open,
  onOpenChange,
  form,
  editingCode,
  properties,
  buildings,
  units,
  onSave,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: UseFormReturn<MaintenanceFormValues>;
  /** رمز الطلب المحرَّر، أو null لطلب جديد. */
  editingCode: string | null;
  properties: Property[];
  buildings: Building[];
  units: Unit[];
  onSave: (values: MaintenanceFormValues) => Promise<void>;
  pending: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingCode !== null ? t("maintenance.edit") : t("maintenance.add")}
          </DialogTitle>
          <DialogDescription>{editingCode ?? t("phase2.codeGenerated")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit(onSave)}>
            <FormSelectField
              required
              control={form.control}
              name="property_id"
              label={t("units.property")}
              options={sortPropertiesByCodeNatural(properties).map((property) => ({
                value: property.id,
                label: property.name_ar,
              }))}
            />
            <FormSelectField
              control={form.control}
              name="building_id"
              label={t("units.building")}
              options={[
                { value: "none", label: t("units.noBuilding") },
                ...buildings.map((building) => ({
                  value: building.id,
                  label: building.name_ar,
                })),
              ]}
            />
            <FormSelectField
              control={form.control}
              name="unit_id"
              label={t("units.name")}
              options={[
                { value: "none", label: t("common.none") },
                ...units.map((unit) => ({ value: unit.id, label: unit.name })),
              ]}
            />
            <FormTextField
              required
              control={form.control}
              name="title"
              label={t("maintenance.requestTitle")}
            />
            <FormSelectField
              required
              control={form.control}
              name="priority"
              label={t("maintenance.priority")}
              options={MAINTENANCE_PRIORITIES.map((value) => ({
                value,
                label: t(`maintenancePriority.${value}`),
              }))}
            />
            <FormSelectField
              required
              control={form.control}
              name="status"
              label={t("common.status")}
              options={MAINTENANCE_STATUSES.map((value) => ({
                value,
                label: t(`maintenanceStatus.${value}`),
              }))}
            />
            <div className="sm:col-span-2">
              <FormTextField
                control={form.control}
                name="description"
                label={t("maintenance.description")}
                multiline
              />
            </div>
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
