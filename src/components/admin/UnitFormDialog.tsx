import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

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
import { useListDrivenOptions, useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useCreateUnit, useUpdateUnit, type Unit } from "@/hooks/useUnits";
import { useI18n } from "@/i18n/provider";
import type { ElectricityMeterOwnership } from "@/integrations/supabase/database.types";
import { mapCatalogueOptions } from "@/lib/commercialActivityOptions";
import { PERMISSIONS } from "@/lib/permissions";
import { sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";
import { showError } from "@/lib/toastError";
import { resolveUnitTypeBinding } from "@/lib/unitFloorTypeBinding";
import {
  buildUnitSubmitPayload,
  NO_UNIT_FLOOR,
  resolvePropertyFieldState,
  resolveUnitFormValues,
  unitFormDefaults,
  unitFormSchema,
  unitStatusEditableValues,
  unitStatusFilterValues,
  type UnitFormValues,
} from "@/lib/unitForm";

export type UnitFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create; set = edit. */
  editing: Unit | null;
  /**
   * Fired after a successful create *or* update with the saved row, so the
   * parent can move its own `editing` state onto it. The dialog no longer
   * closes on save, and the parent owns the title, the code display and the
   * occupancy lookup — all of which would otherwise stay on the create path
   * for as long as the operator leaves the form open.
   */
  onSaved?: (unit: Unit) => void;
  /**
   * When set (property detail page), the Property field shows that property's
   * name and is disabled. Form state still holds `property_id` for submit.
   * When omitted (Units section), Property is a normal dropdown.
   */
  lockedPropertyId?: string | null;
  /**
   * This unit's rent under its active contract, or null when it has none.
   *
   * Display only. The field is read-only on every unit — rent belongs to the
   * contract, never to the unit — so a slow or failed lookup renders an empty
   * box rather than handing the field back to the operator.
   */
  activeContractRent?: number | null;
};

/**
 * Shared unit create/edit dialog for the Units section and the property detail
 * page. One schema, one layout, one Floor field — so the two routes cannot drift.
 */
export function UnitFormDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
  lockedPropertyId = null,
  activeContractRent = null,
}: UnitFormDialogProps) {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const properties = useProperties({ pageSize: 100 }, permissions.can(PERMISSIONS.PROPERTIES_READ));
  const create = useCreateUnit();
  const update = useUpdateUnit();
  const floorItems = useOptionListItemsByCode("unit_floors");
  // Free-text type (migration 103) — catalogue directly, NOT useListDrivenOptions.
  const unitTypeItems = useOptionListItemsByCode("unit_types");
  const form = useForm<UnitFormValues>({
    resolver: zodResolver(unitFormSchema) as Resolver<UnitFormValues>,
    defaultValues: unitFormDefaults,
  });

  const unitStatusFilterOptions = useListDrivenOptions(
    "unit_statuses",
    unitStatusFilterValues,
    "unitStatus",
  );
  const unitStatusEditableOptions = useListDrivenOptions(
    "unit_statuses",
    unitStatusEditableValues,
    "unitStatus",
  );

  const typeValue = form.watch("type");
  const floorValue = form.watch("floor");
  const activeTypeValues = (unitTypeItems.data ?? []).map((typeRow) => typeRow.value);
  const { boundType, locked } = resolveUnitTypeBinding({
    floor: floorValue,
    activeTypeValues,
  });
  const unitTypeMapped = mapCatalogueOptions(unitTypeItems.data ?? [], locale);
  if (typeValue && !unitTypeMapped.some((option) => option.value === typeValue)) {
    // Stale label on an existing unit stays selectable so edit does not wipe it.
    unitTypeMapped.push({ value: typeValue, label: typeValue });
  }
  const unitTypeOptions = unitTypeMapped;

  // An occupied unit shows its real status in a locked control: the only option
  // offered is `occupied` itself. Every other unit gets the three settable statuses.
  const unitIsOccupied = editing?.status === "occupied";
  const unitStatusFieldOptions = unitIsOccupied
    ? unitStatusFilterOptions.filter((option) => option.value === "occupied")
    : unitStatusEditableOptions;

  const propertyField = resolvePropertyFieldState(lockedPropertyId);
  const propertyOptions = sortPropertiesByCodeNatural(properties.data?.items ?? []).map(
    (property) => ({
      value: property.id,
      label: locale === "ar" ? property.name_ar : (property.name_en ?? property.name_ar),
    }),
  );
  // If the locked property is not yet in the list (slow load), still show an
  // option so the disabled control has a label to display.
  if (lockedPropertyId && !propertyOptions.some((option) => option.value === lockedPropertyId)) {
    propertyOptions.push({
      value: lockedPropertyId,
      label: lockedPropertyId,
    });
  }

  // Free-text floor — catalogue directly, NOT useListDrivenOptions (allow-list trap).
  const floorMapped = mapCatalogueOptions(floorItems.data ?? [], locale);
  if (
    floorValue &&
    floorValue !== NO_UNIT_FLOOR &&
    !floorMapped.some((option) => option.value === floorValue)
  ) {
    // Stale label on an existing unit stays selectable so edit does not wipe it.
    floorMapped.push({ value: floorValue, label: floorValue });
  }
  const floorOptions = [{ value: NO_UNIT_FLOOR, label: t("common.none") }, ...floorMapped];

  const meters: ElectricityMeterOwnership[] = ["company_owned", "tenant_owned"];

  /**
   * معرّف السجل الذي أنشأه هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * The form no longer closes on save, so without this a second Save would
   * insert a second row. It is deliberately not `setEditing(saved)`: `editing`
   * is a prop here, and on four other forms in this change its type is a
   * `…WithRelations` the mutation does not return.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const values = resolveUnitFormValues(editing, lockedPropertyId);
      // Show what the tenant is actually billed rather than the stored column.
      // The two disagreeing is the whole reason this field went read-only.
      // `undefined` rather than the stored `default_rent`: a unit with no active
      // contract must render an empty box, not the stale figure the column still
      // happens to hold.
      form.reset({ ...values, default_rent: activeContractRent ?? undefined });
      // A reopened dialog is a fresh create until it saves again.
      setCreatedId(null);
    }
  }, [open, editing, lockedPropertyId, activeContractRent, form]);

  /**
   * يزامن نوع الوحدة مع الطابق المربوط من حالة النموذج لا من معالج التغيير.
   *
   * Opening an existing unit whose floor is bound but whose type is stale must
   * correct the field; a bare onChange would leave a disabled control showing
   * the old value and save nothing. A disabled select does not submit — same
   * trap as resolvePropertyFieldState.
   *
   * Gated on `locked`, not merely on `boundType`. An unlocked binding means the
   * mapped type is absent from the catalogue — the owner deleted it, or it has
   * not loaded yet — and writing it anyway would put an off-catalogue value on
   * the unit while leaving the field editable, which is the T1 bug wearing a
   * different hat.
   */
  useEffect(() => {
    if (!locked || !boundType || typeValue === boundType) return;
    form.setValue("type", boundType, { shouldValidate: true, shouldDirty: false });
  }, [locked, boundType, typeValue, form]);

  /**
   * يحفظ الوحدة ويُبقي النموذج مفتوحًا، فلا يُغلق إلا بإجراء من المستخدم.
   *
   * `editingId` is read into a local before the branch. After a create the
   * dialog stays open, so the *next* Save has to update the row this one just
   * inserted — and `editing` is still null then, because it is a prop this
   * dialog cannot set. Branching on the coalesced value while still reading
   * `editing.id` inside would throw exactly there.
   */
  async function save(values: UnitFormValues) {
    const payload = buildUnitSubmitPayload(values, lockedPropertyId);
    const editingId = editing?.id ?? createdId;
    try {
      // useUpdateUnit drops `status` when the unit is occupied — the field is
      // disabled here, but its value is only correct for as long as the contract
      // it was loaded against is still active.
      const saved = editingId
        ? await update.mutateAsync({ id: editingId, updates: payload })
        : await create.mutateAsync(payload);
      if (!editingId) setCreatedId(saved.id);
      form.reset(values);
      toast.success(t("phase2.saved"));
      // Parents own `editing`, the dialog title and the occupancy lookup, so
      // they are told about the saved row rather than left on the create path.
      onSaved?.(saved);
    } catch (error) {
      showError(t("phase2.saveError"), error);
    }
  }

  const lockedPropertyLabel =
    lockedPropertyId && propertyOptions.find((option) => option.value === lockedPropertyId)?.label;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? t("units.edit") : t("units.add")}</DialogTitle>
          <DialogDescription>
            {lockedPropertyLabel
              ? `${lockedPropertyLabel} — ${editing?.code ?? t("phase2.codeGenerated")}`
              : (editing?.code ?? t("phase2.codeGenerated"))}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit(save)}>
            <FormSelectField
              required
              control={form.control}
              name="property_id"
              label={t("units.property")}
              options={propertyOptions}
              disabled={propertyField.disabled}
            />
            <FormTextField control={form.control} name="paci_no" label={t("units.paciNo")} />
            <FormTextField required control={form.control} name="name" label={t("units.nameAr")} />
            <FormTextField control={form.control} name="name_en" label={t("units.nameEn")} />
            {/* Physical attributes: floor / type / area sit together. Floor first so it can drive type. */}
            <FormSelectField
              control={form.control}
              name="floor"
              label={t("units.floor")}
              placeholder={t("units.floorPlaceholder")}
              options={floorOptions}
              disabled={floorItems.isLoading}
            />
            <FormSelectField
              required
              control={form.control}
              name="type"
              label={t("common.type")}
              options={unitTypeOptions}
              disabled={locked}
            />
            <FormTextField
              control={form.control}
              name="area"
              type="number"
              label={t("common.area")}
            />
            <FormSelectField
              required
              control={form.control}
              name="status"
              label={t("common.status")}
              options={unitStatusFieldOptions}
              disabled={unitIsOccupied}
              description={unitIsOccupied ? t("units.statusDerived") : t("units.statusManualOnly")}
            />
            <FormSelectField
              required
              control={form.control}
              name="electricity_meter_ownership"
              label={t("units.meterOwnership")}
              options={meters.map((value) => ({
                value,
                label: t(`meterOwnership.${value}`),
              }))}
            />
            <div className="space-y-1">
              <FormTextField
                control={form.control}
                name="default_rent"
                type="number"
                label={t("units.defaultRent")}
                readOnly
              />
              <p className="text-xs text-muted-foreground">{t("units.defaultRentFromContract")}</p>
            </div>
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
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
