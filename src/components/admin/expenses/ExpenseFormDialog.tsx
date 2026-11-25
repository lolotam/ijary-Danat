import { Plus } from "lucide-react";
import type { FormEventHandler } from "react";
import type { UseFormReturn } from "react-hook-form";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type Expense, type ExpenseCategory } from "@/hooks/useExpenses";
import { useI18n } from "@/i18n/provider";
import { sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";
import { Field } from "@/components/admin/FieldControls";
import type { Property } from "@/hooks/useProperties";
import type { Unit } from "@/hooks/useUnits";
import { EXPENSE_RECURRENCES, EXPENSE_STATUSES, type ExpenseForm } from "@/lib/expenseForm";

/**
 * حوار إضافة مصروف أو تعديله.
 *
 * Presentational: the form, the record being edited and the save live on the
 * page, because the page opens this dialog and a save keeps it open — the
 * next Save must update the expense just recorded, which only the page knows.
 */
export function ExpenseFormDialog({
  open,
  onOpenChange,
  form,
  isEdit,
  categories,
  properties,
  units,
  canAddCategory,
  onAddCategory,
  onAttachment,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: UseFormReturn<ExpenseForm>;
  isEdit: boolean;
  categories: ExpenseCategory[];
  properties: Property[];
  units: Unit[];
  /** إضافة فئة من داخل النموذج للمدير فقط. */
  canAddCategory: boolean;
  onAddCategory: () => void;
  onAttachment: (file: File | null) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  pending: boolean;
}) {
  const { locale, t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("expenses.edit") : t("expenses.add")}</DialogTitle>
          <DialogDescription>{t("expenses.formHelp")}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={onSubmit}>
          <Field label={t("expenses.payee")}>
            <Input {...form.register("payee")} />
          </Field>
          <Field required label={t("common.amount")} error={form.formState.errors.amount?.message}>
            <Input type="number" step="0.001" min="0" {...form.register("amount")} />
          </Field>
          <Field required label={t("expenses.currency")}>
            <Input dir="ltr" {...form.register("currency")} />
          </Field>
          <Field label={t("expenses.category")}>
            <div className="flex gap-2">
              <Select
                value={form.watch("category_id") || "none"}
                onValueChange={(value) =>
                  form.setValue("category_id", value === "none" ? "" : value)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("common.none")}</SelectItem>
                  {categories
                    .filter((value) => value.is_active || value.id === form.watch("category_id"))
                    .map((value) => (
                      <SelectItem key={value.id} value={value.id}>
                        {locale === "ar" ? value.name_ar : (value.name_en ?? value.name_ar)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button
                title={t("common.add")}
                aria-label={t("common.add")}
                type="button"
                size="icon"
                variant="outline"
                disabled={!canAddCategory}
                onClick={onAddCategory}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </Field>
          <Field
            required
            label={t("expenses.date")}
            error={form.formState.errors.expense_date?.message}
          >
            <DateInput
              value={form.watch("expense_date")}
              onChange={(value) => form.setValue("expense_date", value, { shouldValidate: true })}
            />
          </Field>
          <Field label={t("expenses.property")}>
            <Select
              value={form.watch("property_id") || "none"}
              onValueChange={(value) => {
                form.setValue("property_id", value === "none" ? "" : value);
                form.setValue("unit_id", "");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("common.none")}</SelectItem>
                {sortPropertiesByCodeNatural(properties).map((value) => (
                  <SelectItem key={value.id} value={value.id}>
                    {value.code} —{" "}
                    {locale === "ar" ? value.name_ar : (value.name_en ?? value.name_ar)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("expenses.unit")}>
            <Select
              value={form.watch("unit_id") || "none"}
              onValueChange={(value) => form.setValue("unit_id", value === "none" ? "" : value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("common.none")}</SelectItem>
                {units.map((value) => (
                  <SelectItem key={value.id} value={value.id}>
                    {value.code} — {value.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("expenses.costCenter")}>
            <Input {...form.register("cost_center")} />
          </Field>
          <Field label={t("expenses.startDate")}>
            <DateInput
              value={form.watch("start_date")}
              onChange={(value) => form.setValue("start_date", value, { shouldValidate: true })}
            />
          </Field>
          <Field label={t("expenses.endDate")} error={form.formState.errors.end_date?.message}>
            <DateInput
              value={form.watch("end_date")}
              onChange={(value) => form.setValue("end_date", value, { shouldValidate: true })}
            />
          </Field>
          <Field label={t("expenses.recurrence")}>
            <Select
              value={form.watch("recurrence") || "none"}
              onValueChange={(value) => form.setValue("recurrence", value === "none" ? "" : value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("common.none")}</SelectItem>
                {EXPENSE_RECURRENCES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`recurrence.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field required label={t("common.status")}>
            <Select
              value={form.watch("status")}
              onValueChange={(value) => form.setValue("status", value as Expense["status"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`expenseStatus.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("expenses.attachment")}>
            <Input
              type="file"
              accept="image/*,.pdf"
              onChange={(event) => onAttachment(event.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="space-y-2 sm:col-span-2 lg:col-span-3">
            <Label>{t("common.notes")}</Label>
            <Textarea {...form.register("note")} />
          </div>
          <DialogFooter className="sm:col-span-2 lg:col-span-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
