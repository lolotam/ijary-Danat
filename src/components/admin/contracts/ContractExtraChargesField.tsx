import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ExpenseCategory } from "@/hooks/useExpenses";
import { useI18n } from "@/i18n/provider";
import type { ContractExtraChargeValue } from "@/lib/contractForm";

export interface ContractExtraChargesFieldLabels {
  heading: string;
  description: string;
  category: string;
  amount: string;
  add: string;
  remove: string;
  noCategories: string;
  selectCategory: string;
}

export interface ContractExtraChargesFieldProps {
  rows: ContractExtraChargeValue[];
  categories: ExpenseCategory[];
  onChange: (rows: ContractExtraChargeValue[]) => void;
  /** رسائل تحقّق لكل صف، بترتيب الصفوف. */
  amountErrors?: Array<string | undefined>;
  labels: ContractExtraChargesFieldLabels;
}

/**
 * مصروفات شهرية إضافية على العقد، لكل منها تصنيف ومبلغ.
 *
 * These are billed on every invoice the contract raises, alongside the rent
 * and as their own lines — 1,000 rent plus a 100 cleaning charge invoices at
 * 1,100 with both visible. A category already taken is removed from the other
 * rows' options because the database holds one charge per category per
 * contract; two "cleaning" rows would render as two identical PDF lines that
 * nobody could tell apart.
 *
 * Its own component rather than more markup in `ContractFormDialog`: that file
 * sits at 595 lines against this repository's 500-600 ceiling, and this field
 * plus the total card would have carried it well past.
 */
export function ContractExtraChargesField({
  rows,
  categories,
  onChange,
  amountErrors,
  labels,
}: ContractExtraChargesFieldProps) {
  const { locale } = useI18n();
  const takenCategoryIds = new Set(rows.map((row) => row.category_id).filter(Boolean));

  function categoryName(category: ExpenseCategory): string {
    return locale === "ar" ? category.name_ar : (category.name_en ?? category.name_ar);
  }

  function setRow(index: number, patch: Partial<ContractExtraChargeValue>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-3 sm:col-span-2 lg:col-span-3">
      <div className="space-y-1">
        <Label>{labels.heading}</Label>
        <p className="text-xs text-muted-foreground">{labels.description}</p>
      </div>

      {categories.length === 0 ? (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">{labels.noCategories}</p>
      ) : null}

      {rows.map((row, index) => (
        <div
          key={`${row.category_id || "unset"}-${index}`}
          className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
        >
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor={`extra-charge-category-${index}`}>{labels.category}</Label>
            <Select
              value={row.category_id || undefined}
              onValueChange={(value) => setRow(index, { category_id: value })}
            >
              <SelectTrigger id={`extra-charge-category-${index}`}>
                <SelectValue placeholder={labels.selectCategory} />
              </SelectTrigger>
              <SelectContent>
                {categories
                  // The row's own category stays listed, or the trigger would
                  // render an empty selection over a value that is really set.
                  .filter(
                    (category) =>
                      category.id === row.category_id || !takenCategoryIds.has(category.id),
                  )
                  .map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {categoryName(category)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-40 flex-1 space-y-1">
            <Label required htmlFor={`extra-charge-amount-${index}`}>
              {labels.amount}
            </Label>
            {/*
              `step` must accompany `min`: the browser derives the valid set
              from min + n*step, and the default step of 1 would make a plain
              150 invalid against min="0.001" — native validation then blocks
              submission with no visible error. KWD is three decimal places.
            */}
            <Input
              id={`extra-charge-amount-${index}`}
              type="number"
              inputMode="decimal"
              min="0.001"
              step="0.001"
              value={String(row.amount)}
              onChange={(event) => setRow(index, { amount: Number(event.target.value) || 0 })}
            />
            {amountErrors?.[index] ? (
              <p className="text-sm text-destructive">{amountErrors[index]}</p>
            ) : null}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={labels.remove}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        // Every category already spoken for means a new row could only ever be
        // a duplicate, which the database rejects.
        disabled={categories.length === 0 || takenCategoryIds.size >= categories.length}
        onClick={() => onChange([...rows, { category_id: "", amount: 0 }])}
      >
        <Plus className="me-2 h-4 w-4" />
        {labels.add}
      </Button>
    </div>
  );
}
