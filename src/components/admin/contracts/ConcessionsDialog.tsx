import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useServerFn } from "@tanstack/react-start";
import { useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { FormSelectField, FormTextField } from "@/components/admin/Phase2FormFields";
import { DeleteConfirmation } from "@/components/admin/Phase2Ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { ConcessionsTable } from "@/components/admin/contracts/ConcessionsTable";
import {
  concessionDefaults,
  concessionFormDefaults,
  concessionSchema,
  freeMonthsEndDate,
  type ConcessionValues,
} from "@/components/admin/contracts/concessionForm";
import { ExtraChargeWaiverDialog } from "@/components/admin/contracts/ExtraChargeWaiverDialog";
import { invoicesNeedingWaiverPrompt } from "@/lib/extraChargeWaiver";
import {
  useConcessionInvoiceCoverage,
  useApplyConcessionToInvoices,
  useDiscountableInvoices,
  formatDiscountableInvoiceLabel,
  type DiscountableInvoice,
  periodBoundsFromInvoices,
} from "@/hooks/useConcessionInvoices";
import {
  useConcessions,
  useCreateConcession,
  useDeleteConcession,
  type Concession,
  type Contract,
} from "@/hooks/useContracts";
import { usePermissions } from "@/hooks/usePermissions";
import { summarizeRegeneration } from "@/fns/regenerateContractInvoices";
import { syncContractSchedule } from "@/fns/syncContractSchedule";
import { useI18n } from "@/i18n/provider";
import type { ConcessionType } from "@/integrations/supabase/database.types";
import { PERMISSIONS } from "@/lib/permissions";
import { showError } from "@/lib/toastError";

/**
 * حوار إدارة التنازلات: الأشهر المجانية تبقى نطاقاً تاريخياً، والخصم يُربَط بفواتير.
 */
export function ConcessionsDialog({
  contract,
  close,
}: {
  contract: Contract | null;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const concessions = useConcessions(contract?.id ?? null);
  const coverage = useConcessionInvoiceCoverage(contract?.id ?? null);
  const eligible = useDiscountableInvoices(contract?.id ?? null);
  const create = useCreateConcession();
  const remove = useDeleteConcession();
  const apply = useApplyConcessionToInvoices();
  // The pending discount, parked while the operator answers the waiver prompt.
  // Holding the whole submission rather than a boolean is what lets `add` stay
  // one function with one exit: it returns, and the dialog's confirm resumes it.
  const [waiverPrompt, setWaiverPrompt] = useState<{
    values: ConcessionValues;
    bounds: { start_date: string; end_date: string };
    candidates: DiscountableInvoice[];
  } | null>(null);
  const syncInvoices = useServerFn(syncContractSchedule);
  const [deleteTarget, setDeleteTarget] = useState<Concession | null>(null);
  const form = useForm<ConcessionValues>({
    resolver: zodResolver(concessionSchema) as Resolver<ConcessionValues>,
    defaultValues: concessionDefaults,
  });
  const selectedType = form.watch("type");
  const freeMonths = form.watch("free_months");

  useEffect(() => {
    if (contract) form.reset(concessionFormDefaults(contract));
  }, [contract, form]);

  useEffect(() => {
    if (!contract) return;
    form.setValue("start_date", contract.start_date, { shouldDirty: false });
    if (selectedType === "free_months") {
      const end = freeMonthsEndDate(contract.start_date, freeMonths ?? 1);
      if (end) form.setValue("end_date", end, { shouldDirty: false });
      form.setValue("invoice_ids", [], { shouldDirty: false });
    }
  }, [contract, form, freeMonths, selectedType]);

  /**
   * يزامن جدول فواتير العقد بعد تغيير أشهر مجانية فقط.
   *
   * `sync_contract_invoice_schedule`, not `reapply_contract_invoices`: reapply
   * only deletes invoices up to the current month, so adding three free months
   * to a contract that starts this month removed exactly one invoice and left
   * the other two standing (migration 139). Sync prunes and refills across the
   * whole recorded horizon, which is also what brings months back when the free
   * count is reduced.
   *
   * Percentage/fixed discounts are bound by apply_concession_to_invoices and
   * are skipped by the sync, so deleting one restores its invoice through the
   * delete trigger rather than by regenerating it under a new code.
   */
  async function syncAfterFreeMonths(contractId: string) {
    try {
      const rows = await syncInvoices({ data: { contractId } });
      const summary = summarizeRegeneration(rows as Array<{ action: string }> | null);
      const count = Array.isArray(rows) ? rows.length : 0;
      if (summary.blocked > 0) {
        // Reporting a plain success here is how the operator ends up believing
        // a month was made free while the tenant is still being billed for it:
        // a discounted invoice inside a newly-free month is left in place by
        // design, because only a human can decide which of the two settings
        // wins.
        toast.warning(
          t("contracts.regeneratedWithBlocked")
            .replace("{updated}", String(summary.updated))
            .replace("{inserted}", String(summary.inserted))
            .replace("{blocked}", String(summary.blocked)),
        );
      } else if (count > 0) {
        toast.success(t("concessions.reapplied").replace("{count}", String(count)));
      }
    } catch (error) {
      showError(t("concessions.reapplyError"), error);
    }
  }

  /**
   * يضيف تنازلاً: أشهر مجانية بالنطاق، أو خصم مربوط بالفواتير المختارة.
   */
  async function add(values: ConcessionValues) {
    if (!contract) return;
    if (values.type === "free_months") {
      const startDate = contract.start_date;
      const endDate = freeMonthsEndDate(startDate, values.free_months ?? 1);
      if (!endDate) {
        form.setError("end_date", { message: t("concessions.freeMonths") });
        return;
      }
      try {
        await create.mutateAsync({
          type: "free_months",
          status: values.status,
          contract_id: contract.id,
          start_date: startDate,
          end_date: endDate,
          free_months: values.free_months ?? 0,
          discount_percent: null,
          discount_amount: null,
          reason: values.reason.trim() || null,
        });
        await syncAfterFreeMonths(contract.id);
        form.reset(concessionFormDefaults(contract));
        toast.success(t("phase2.saved"));
      } catch (error) {
        showError(t("phase2.saveError"), error);
      }
      return;
    }

    const selected = (eligible.data ?? []).filter((invoice) =>
      values.invoice_ids.includes(invoice.id),
    );
    const bounds = periodBoundsFromInvoices(selected);
    if (!bounds) {
      form.setError("invoice_ids", { message: t("concessions.selectInvoices") });
      return;
    }

    // Ask before creating anything. A month whose rent this discount wipes out
    // entirely, and which still carries a service charge, is a month the
    // operator may have meant to make free outright — and the invoice would
    // otherwise go out showing the charge alone.
    const candidates = invoicesNeedingWaiverPrompt(
      selected,
      values.type === "percentage_discount"
        ? { type: "percentage_discount", percent: values.discount_percent ?? 0 }
        : { type: "fixed_discount", amount: values.discount_amount ?? 0 },
    );
    if (candidates.length > 0) {
      // The bounds travel with the parked submission. Recomputing them when the
      // operator answers would mean handling a failure that cannot happen here
      // — and the only sane thing to do with it would be to close the dialog
      // having silently done nothing.
      setWaiverPrompt({ values, bounds, candidates });
      return;
    }
    await submitDiscount(values, bounds, []);
  }

  /**
   * ينشئ التنازل ويربطه بالفواتير، مع قائمة الأشهر المتنازَل عن مصروفاتها.
   *
   * Split out of `add` so the waiver prompt can resume the same submission it
   * interrupted, rather than the dialog having to rebuild it.
   */
  async function submitDiscount(
    values: ConcessionValues,
    bounds: { start_date: string; end_date: string },
    waiveExtraChargeInvoiceIds: string[],
  ) {
    if (!contract) return;
    try {
      const created = await create.mutateAsync({
        type: values.type,
        status: values.status,
        contract_id: contract.id,
        start_date: bounds.start_date,
        end_date: bounds.end_date,
        free_months: 0,
        discount_percent:
          values.type === "percentage_discount" ? (values.discount_percent ?? null) : null,
        discount_amount: values.type === "fixed_discount" ? (values.discount_amount ?? null) : null,
        reason: values.reason.trim() || null,
      });
      try {
        await apply.mutateAsync({
          concessionId: created.id,
          invoiceIds: values.invoice_ids,
          waiveExtraChargeInvoiceIds,
        });
      } catch (applyError) {
        await remove.mutateAsync(created);
        throw applyError;
      }
      form.reset(concessionFormDefaults(contract));
      setWaiverPrompt(null);
      toast.success(t("phase2.saved"));
    } catch (error) {
      showError(t("phase2.saveError"), error);
    }
  }

  /**
   * يحذف التنازل. الاستعادة المالية تتم في trigger الحذف، لا بإعادة التوليد.
   */
  async function confirmDelete() {
    if (!deleteTarget || !contract) return;
    try {
      await remove.mutateAsync(deleteTarget);
      if (deleteTarget.type === "free_months") {
        await syncAfterFreeMonths(contract.id);
      }
      setDeleteTarget(null);
      toast.success(t("phase2.deleted"));
    } catch (error) {
      showError(t("phase2.deleteError"), error);
    }
  }

  const types: ConcessionType[] = ["free_months", "percentage_discount", "fixed_discount"];
  return (
    <Dialog open={Boolean(contract)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("concessions.title")}</DialogTitle>
          <DialogDescription>
            {contract?.code}
            {selectedType === "free_months" ? ` — ${t("concessions.freeMonthsHint")}` : ""}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4 rounded-xl border p-4 sm:grid-cols-3"
            onSubmit={form.handleSubmit(add)}
          >
            <FormSelectField
              required
              control={form.control}
              name="type"
              label={t("common.type")}
              options={types.map((value) => ({ value, label: t(`concessionType.${value}`) }))}
            />
            {selectedType === "free_months" && (
              <FormTextField
                required
                control={form.control}
                name="free_months"
                type="number"
                label={t("concessions.freeMonths")}
              />
            )}
            {selectedType === "percentage_discount" && (
              <FormTextField
                required
                control={form.control}
                name="discount_percent"
                type="number"
                label={t("concessions.discountPercent")}
              />
            )}
            {selectedType === "fixed_discount" && (
              <FormTextField
                required
                control={form.control}
                name="discount_amount"
                type="number"
                label={t("concessions.discountAmount")}
              />
            )}
            <FormSelectField
              required
              control={form.control}
              name="status"
              label={t("common.status")}
              options={["active", "expired", "cancelled"].map((value) => ({
                value,
                label: t(`concessionStatus.${value}`),
              }))}
            />
            {selectedType === "free_months" ? (
              <>
                <FormTextField
                  control={form.control}
                  name="start_date"
                  type="date"
                  label={t("common.from")}
                  readOnly
                />
                <FormTextField
                  required
                  control={form.control}
                  name="end_date"
                  type="date"
                  label={t("common.to")}
                  readOnly
                />
              </>
            ) : (
              <FormField
                control={form.control}
                name="invoice_ids"
                render={({ field }) => (
                  <FormItem className="sm:col-span-3">
                    <FormLabel required>{t("concessions.selectInvoices")}</FormLabel>
                    <FormControl>
                      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                        {eligible.isLoading ? (
                          <p className="p-2 text-sm text-muted-foreground">{t("common.loading")}</p>
                        ) : eligible.error ? (
                          /* A failed query used to fall through to the empty state below,
                             so a gateway 414 read as "this contract has no unpaid
                             invoices" - a wrong answer presented as a right one, and the
                             reason the truncation went unnoticed. Same copy and tone as
                             TableState's error branch. */
                          <p className="p-2 text-sm text-destructive">{t("common.error")}</p>
                        ) : !eligible.data?.length ? (
                          <p className="p-2 text-sm text-muted-foreground">
                            {t("concessions.noEligibleInvoices")}
                          </p>
                        ) : (
                          eligible.data.map((invoice) => {
                            const checked = field.value.includes(invoice.id);
                            return (
                              <label
                                key={invoice.id}
                                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(value) => {
                                    const next = value
                                      ? [...field.value, invoice.id]
                                      : field.value.filter((id) => id !== invoice.id);
                                    field.onChange(next);
                                  }}
                                />
                                <span>{formatDiscountableInvoiceLabel(invoice, locale)}</span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      {t("concessions.selectInvoicesPlaceholder")}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormTextField control={form.control} name="reason" label={t("concessions.reason")} />
            <Button
              className="sm:col-span-3"
              type="submit"
              disabled={!permissions.can(PERMISSIONS.CONTRACTS_UPDATE) || create.isPending}
            >
              {t("concessions.add")}
            </Button>
          </form>
        </Form>
        <ConcessionsTable
          concessions={concessions}
          coverage={coverage}
          canUpdate={permissions.can(PERMISSIONS.CONTRACTS_UPDATE)}
          onDelete={setDeleteTarget}
        />
        <DeleteConfirmation
          open={Boolean(deleteTarget)}
          pending={remove.isPending}
          title={t("phase2.deleteTitle")}
          description={t("phase2.deleteDescription")}
          close={() => setDeleteTarget(null)}
          confirm={confirmDelete}
        />
        <ExtraChargeWaiverDialog
          open={Boolean(waiverPrompt)}
          pending={create.isPending || apply.isPending}
          candidates={waiverPrompt?.candidates ?? []}
          onCancel={() => setWaiverPrompt(null)}
          onConfirm={(waiveInvoiceIds: string[]) => {
            if (!waiverPrompt) return;
            void submitDiscount(waiverPrompt.values, waiverPrompt.bounds, waiveInvoiceIds);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
