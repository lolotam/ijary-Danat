import { useCallback, useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useServerFn } from "@tanstack/react-start";
import { useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { ContractUnitsField, type ContractUnitValue } from "@/components/admin/ContractUnitsField";
import { ContractEndDateFields } from "@/components/admin/contracts/ContractEndDateFields";
import { ContractExtraChargesField } from "@/components/admin/contracts/ContractExtraChargesField";
import { ContractIncreaseSection } from "@/components/admin/contracts/ContractIncreaseSection";
import { ContractMonthlyTotalCard } from "@/components/admin/contracts/ContractMonthlyTotalCard";
import { ContractPastEndConfirmDialog } from "@/components/admin/contracts/ContractPastEndConfirmDialog";
import { ContractSuppressBillingDocsField } from "@/components/admin/contracts/ContractSuppressBillingDocsField";
import { useContractFormPrefill } from "@/components/admin/contracts/useContractFormPrefill";
import { useContractIncreaseLock } from "@/components/admin/contracts/useContractIncreaseLock";
import { useContractUnitOccupancy } from "@/components/admin/contracts/useContractUnitOccupancy";
import { contractCommercialActivityOptions } from "@/components/admin/contracts/contractCommercialActivityOptions";
import {
  contractExtraChargesLabels,
  contractIncreaseLabels,
  contractMonthlyTotalLabels,
  contractUnitsLabels,
} from "@/components/admin/contracts/contractFormLabels";
import { FormSelectField, FormTextField } from "@/components/admin/Phase2FormFields";
import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
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
import { backfillContractInvoices } from "@/fns/backfillContractInvoices";
import { summarizeRegeneration } from "@/fns/regenerateContractInvoices";
import { syncContractSchedule } from "@/fns/syncContractSchedule";
import { isInsuranceDeleteForbidden } from "@/hooks/useContractInsurance";
import {
  type Contract,
  type ContractWithRelations,
  useContractExtraCharges,
  useRefreshContractInvoices,
  useSaveContractWithUnits,
  useSyncContractInsurance,
} from "@/hooks/useContracts";
import { useExpenseCategories } from "@/hooks/useExpenses";
import { useListDrivenOptions, useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useTenants } from "@/hooks/useTenants";
import { useUnits } from "@/hooks/useUnits";
import { useI18n } from "@/i18n/provider";
import type { ContractType } from "@/integrations/supabase/database.types";
import { fillPlaceholders, regenerationToast } from "@/lib/regenerationToast";
import {
  buildContractSavePayload,
  calculatedEndDate,
  contractFormDefaults,
  contractFormSchema,
  contractStates,
  isEndDateOverridden,
  resolveContractFormValues,
  type ContractFormValues,
} from "@/lib/contractForm";
import {
  isContractEndInPast,
  needsPastEndConfirmation,
  resolveUnitCode,
} from "@/lib/contractLifecycle";
import { joinLocalizedList } from "@/lib/contractUnits";
import { PERMISSIONS } from "@/lib/permissions";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";
import { showError } from "@/lib/toastError";

export type ContractFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create; set = edit. */
  editing: ContractWithRelations | null;
};

/**
 * حوار إنشاء/تعديل العقد — النموذج والحفظ يعيشان هنا حتى يبقى المسار للتنسيق فقط.
 *
 * The dialog stays open after a save. `createdId` is what makes the next Save
 * an update: `editing` is still null on the create path, and promoting it
 * would require a `ContractWithRelations` the save RPC does not return.
 */
export function ContractFormDialog({ open, onOpenChange, editing }: ContractFormDialogProps) {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [overrideEnd, setOverrideEnd] = useState(false);
  const [pastEndConfirmValues, setPastEndConfirmValues] = useState<ContractFormValues | null>(null);
  // Last persisted deposit. The delete fires on a positive→zero *transition*,
  // so a create that stays open and is then zeroed still has a previous amount.
  const previousDepositRef = useRef(0);
  const form = useForm<ContractFormValues>({
    resolver: zodResolver(contractFormSchema) as Resolver<ContractFormValues>,
    defaultValues: contractFormDefaults,
  });
  const tenants = useTenants({ pageSize: 500 }, permissions.can(PERMISSIONS.TENANTS_READ));
  const units = useUnits({ pageSize: 500 }, permissions.can(PERMISSIONS.UNITS_READ));
  const properties = useProperties({ pageSize: 500 }, permissions.can(PERMISSIONS.PROPERTIES_READ));
  const expenseCategories = useExpenseCategories(permissions.can(PERMISSIONS.EXPENSES_READ));
  const existingExtraCharges = useContractExtraCharges(editing?.id ?? null);
  const saveContract = useSaveContractWithUnits();
  const refreshContractInvoices = useRefreshContractInvoices();
  const backfillInvoices = useServerFn(backfillContractInvoices);
  const regenerateInvoices = useServerFn(syncContractSchedule);
  const syncInsurance = useSyncContractInsurance();
  const selectedPropertyIds = form.watch("property_ids");
  const selectedUnits = form.watch("units");
  const selectedUnitIds = selectedUnits.map((row) => row.unit_id);
  const extraCharges = form.watch("extra_charges");
  const startDate = form.watch("start_date");
  const endDate = form.watch("end_date");
  const durationMonths = form.watch("duration_months");
  const { occupiedUnitIds, conflicts } = useContractUnitOccupancy({
    units: units.data?.items,
    propertyIds: selectedPropertyIds,
    selectedUnitIds,
    excludeContractId: editing?.id ?? createdId ?? undefined,
  });
  const contractTypeOptions = useListDrivenOptions(
    "contract_types",
    ["investment", "lease"] as ContractType[],
    "contractType",
  );
  const contractStateOptions = useListDrivenOptions(
    "contract_states",
    contractStates,
    "contractState",
  );
  const commercialActivityItems = useOptionListItemsByCode("commercial_activities");
  const endDateIsPast = isContractEndInPast(endDate);
  const suppressBillingDocs = form.watch("suppress_tenant_billing_docs");
  const increase = form.watch("increase");

  const increaseLocked = useContractIncreaseLock(editing ?? null);

  const { chargesAreKnown } = useContractFormPrefill({
    open,
    editing,
    editingId: editing?.id ?? null,
    form,
    extraCharges: existingExtraCharges,
    onPrefilled: useCallback(
      (values: ContractFormValues) => {
        setOverrideEnd(isEndDateOverridden(values));
        setCreatedId(null);
        previousDepositRef.current = Number(editing?.deposit ?? 0);
      },
      [editing?.deposit],
    ),
  });
  useEffect(() => {
    if (!overrideEnd && startDate && durationMonths) {
      form.setValue("end_date", calculatedEndDate(startDate, durationMonths), {
        shouldDirty: false,
      });
    }
  }, [durationMonths, form, overrideEnd, startDate]);

  /**
   * يعكس مبلغ تأمين العقد في تبويب التأمين بعد نجاح الحفظ.
   *
   * Runs only once the contract is durably saved, and reports its own outcome —
   * this leg legitimately 403s for a role holding contracts.create but not
   * insurance.create, and that must not read as a failed contract save.
   */
  async function mirrorInsurance(contract: Contract, previousAmount: number) {
    try {
      const outcome = await syncInsurance.mutateAsync({ contract, previousAmount });
      if (outcome !== "unchanged") toast.success(t(`contracts.insurance.${outcome}`));
    } catch (error) {
      showError(
        t(
          isInsuranceDeleteForbidden(error)
            ? "contracts.insuranceDeleteFailed"
            : "contracts.insuranceError",
        ),
        error,
      );
    }
  }

  /**
   * يتحقق من تجاوز تاريخ النهاية ثم يحفظ، أو يطلب تأكيد انتهاء عقد ماضٍ.
   */
  async function save(values: ContractFormValues) {
    const calculated = calculatedEndDate(values.start_date, values.duration_months);
    if (values.end_date !== calculated && !values.end_date_override_reason.trim()) {
      setOverrideEnd(true);
      form.setError("end_date_override_reason", { message: t("contracts.overrideRequired") });
      return;
    }
    if (needsPastEndConfirmation(values.end_date, values.state)) {
      setPastEndConfirmValues(values);
      return;
    }
    await persistContract(values);
  }

  /**
   * يثبّت الحالة «منتهٍ» بعد تأكيد المشغّل ثم يحفظ.
   */
  async function confirmPastEndSave() {
    if (!pastEndConfirmValues) return;
    const values: ContractFormValues = { ...pastEndConfirmValues, state: "expired" };
    setPastEndConfirmValues(null);
    form.setValue("state", "expired", { shouldDirty: true });
    await persistContract(values);
  }

  /**
   * يكتب العقد ووحداته، ثم يعكس التأمين ويوائم الفواتير.
   */
  async function persistContract(values: ContractFormValues) {
    if (conflicts.data && conflicts.data.size > 0) {
      form.setError("units", { message: t("contracts.unitConflict") });
      return;
    }
    // Omitted, not empty, when we never learned what the contract already
    // charges: absent means "leave them alone" and `[]` means "delete them
    // all", and sending the wrong one silently cuts every future invoice.
    const { contract: contractPayload, units: unitsPayload } = buildContractSavePayload(
      values,
      chargesAreKnown,
    );
    if (!chargesAreKnown) toast.warning(t("contracts.extraChargesNotLoaded"));
    const editingId = editing?.id ?? createdId;
    try {
      if (editingId) {
        const saved = await saveContract.mutateAsync({
          id: editingId,
          contract: contractPayload,
          units: unitsPayload,
        });
        await mirrorInsurance(saved, previousDepositRef.current);
        previousDepositRef.current = Number(saved.deposit ?? 0);
        try {
          const rows = await regenerateInvoices({ data: { contractId: editingId } });
          const outcome = regenerationToast(
            summarizeRegeneration(rows as Array<{ action: string }> | null),
          );
          if (outcome) {
            const message = fillPlaceholders(t(outcome.key), outcome.values);
            if (outcome.kind === "warning") toast.warning(message);
            else toast.success(message);
          }
        } catch (regenerateError) {
          showError(t("contracts.regenerateError"), regenerateError);
        } finally {
          refreshContractInvoices();
        }
      } else {
        const created = await saveContract.mutateAsync({
          contract: contractPayload,
          units: unitsPayload,
        });
        setCreatedId(created.id);
        await mirrorInsurance(created, previousDepositRef.current);
        previousDepositRef.current = Number(created.deposit ?? 0);
        try {
          const rows = await backfillInvoices({ data: { contractId: created.id } });
          if (Array.isArray(rows) && rows.length) {
            toast.success(t("contracts.backfilled").replace("{count}", String(rows.length)));
          }
        } catch (backfillError) {
          showError(t("contracts.backfillError"), backfillError);
        } finally {
          refreshContractInvoices();
        }
      }
      form.reset(values);
      toast.success(t("phase2.saved"));
    } catch (error) {
      showError(t("phase2.saveError"), error);
    }
  }

  const tenantOptions = (tenants.data?.items ?? []).map((tenant, index) => ({
    value: tenant.id,
    label: (
      <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
        {tenant.code} — {tenantDisplayName(tenant, locale)}
      </TenantOptionLabel>
    ),
  }));
  const formStateOptions = endDateIsPast
    ? contractStateOptions.filter((option) => option.value !== "active")
    : contractStateOptions;
  const commercialActivityOptions = contractCommercialActivityOptions(
    commercialActivityItems.data ?? [],
    form.watch("commercial_activity"),
    locale,
    t("common.none"),
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? t("contracts.edit") : t("contracts.add")}</DialogTitle>
            <DialogDescription>{editing?.code ?? t("phase2.codeGenerated")}</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={form.handleSubmit(save)}
            >
              <FormSelectField
                required
                control={form.control}
                name="tenant_id"
                label={t("contracts.tenant")}
                options={tenantOptions}
              />
              <ContractUnitsField
                properties={properties.data?.items ?? []}
                units={units.data?.items ?? []}
                propertyIds={selectedPropertyIds}
                onPropertyIdsChange={(ids) =>
                  form.setValue("property_ids", ids, { shouldDirty: true })
                }
                unitRows={selectedUnits}
                onUnitRowsChange={(rows: ContractUnitValue[]) =>
                  form.setValue("units", rows, { shouldDirty: true })
                }
                amountErrors={selectedUnits.map((_, index) => {
                  const message = form.formState.errors.units?.[index]?.monthly_amount?.message;
                  return message ? t(message) : undefined;
                })}
                occupiedUnitIds={occupiedUnitIds}
                locale={locale}
                labels={contractUnitsLabels(t)}
              />
              {(form.formState.errors.property_ids?.message ||
                form.formState.errors.units?.message) && (
                <p className="sm:col-span-2 lg:col-span-3 text-sm text-destructive">
                  {form.formState.errors.property_ids?.message ??
                    form.formState.errors.units?.message}
                </p>
              )}
              <ContractExtraChargesField
                rows={extraCharges}
                categories={expenseCategories.data ?? []}
                onChange={(rows) => form.setValue("extra_charges", rows, { shouldDirty: true })}
                amountErrors={extraCharges.map((_, index) => {
                  const message = form.formState.errors.extra_charges?.[index]?.amount?.message;
                  return message ? t(message) : undefined;
                })}
                labels={contractExtraChargesLabels(t)}
              />
              <ContractIncreaseSection
                value={increase}
                onChange={(next) => form.setValue("increase", next, { shouldDirty: true })}
                locked={increaseLocked}
                startDate={startDate}
                locale={locale}
                labels={contractIncreaseLabels(t)}
                valueError={(() => {
                  // Both trio fields report through one line under the value
                  // input; a bad after_years is rarer and reads fine there.
                  const message =
                    form.formState.errors.increase?.value?.message ??
                    form.formState.errors.increase?.after_years?.message;
                  return message ? t(message) : undefined;
                })()}
              />
              <FormSelectField
                required
                control={form.control}
                name="type"
                label={t("common.type")}
                options={contractTypeOptions}
              />
              <FormSelectField
                control={form.control}
                name="commercial_activity"
                label={t("contracts.commercialActivity")}
                placeholder={t("contracts.commercialActivityPlaceholder")}
                options={commercialActivityOptions}
                disabled={commercialActivityItems.isLoading}
              />
              <FormTextField
                required
                control={form.control}
                name="start_date"
                type="date"
                label={t("contracts.start")}
              />
              <FormTextField
                required
                control={form.control}
                name="duration_months"
                type="number"
                label={t("contracts.durationMonths")}
              />
              <ContractEndDateFields
                form={form}
                overrideEnd={overrideEnd}
                onOverrideEndChange={setOverrideEnd}
                startDate={startDate}
                durationMonths={durationMonths}
              />
              <FormSelectField
                required
                control={form.control}
                name="state"
                label={t("common.status")}
                options={formStateOptions}
              />
              <FormTextField
                required
                control={form.control}
                name="due_day"
                type="number"
                label={t("contracts.dueDay")}
              />
              <FormTextField
                required
                control={form.control}
                name="grace_days"
                type="number"
                label={t("contracts.graceDays")}
              />
              <FormTextField
                required
                control={form.control}
                name="deposit"
                type="number"
                label={t("contracts.deposit")}
              />
              <div className="sm:col-span-2 lg:col-span-3">
                <FormTextField
                  control={form.control}
                  name="notes"
                  label={t("common.notes")}
                  multiline
                />
              </div>
              <ContractSuppressBillingDocsField
                checked={Boolean(suppressBillingDocs)}
                onCheckedChange={(checked) =>
                  form.setValue("suppress_tenant_billing_docs", checked, { shouldDirty: true })
                }
              />
              <ContractMonthlyTotalCard
                units={selectedUnits}
                extraCharges={extraCharges}
                categories={expenseCategories.data ?? []}
                labels={contractMonthlyTotalLabels(t)}
              />
              {conflicts.data && conflicts.data.size > 0 && (
                <p className="sm:col-span-2 lg:col-span-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {t("contracts.unitConflict")}:{" "}
                  {joinLocalizedList(
                    [...conflicts.data.entries()].map(
                      ([unitId, contract]) =>
                        `${resolveUnitCode(unitId, units.data?.items ?? []) ?? unitId} (${contract.code})`,
                    ),
                    locale,
                  )}
                </p>
              )}
              <DialogFooter className="sm:col-span-2 lg:col-span-3">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    saveContract.isPending || Boolean(conflicts.data && conflicts.data.size > 0)
                  }
                >
                  {t("common.save")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <ContractPastEndConfirmDialog
        values={pastEndConfirmValues}
        units={units.data?.items ?? []}
        pending={saveContract.isPending}
        onDismiss={() => setPastEndConfirmValues(null)}
        onConfirm={() => void confirmPastEndSave()}
      />
    </>
  );
}
