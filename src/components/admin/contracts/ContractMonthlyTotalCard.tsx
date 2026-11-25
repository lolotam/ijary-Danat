import { LtrText } from "@/components/ui/ltr-text";
import type { ExpenseCategory } from "@/hooks/useExpenses";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";
import { monthlyInvoiceTotal, type ContractExtraChargeValue } from "@/lib/contractForm";

export interface ContractMonthlyTotalCardProps {
  units: ReadonlyArray<{ unit_id: string; monthly_amount: number }>;
  extraCharges: ReadonlyArray<ContractExtraChargeValue>;
  categories: ExpenseCategory[];
  labels: {
    heading: string;
    rent: string;
    total: string;
  };
}

/**
 * إجمالي الفاتورة الشهرية المتوقّعة، بعد الملاحظات في نهاية النموذج.
 *
 * Moved here from under the units list. The figure only becomes true once the
 * properties, the units, their rents AND the extra charges are all entered, so
 * showing it beside the units meant showing a number that was still wrong for
 * the rest of the form — an operator reading it there was reading a rent
 * subtotal labelled as a total.
 *
 * It breaks the sum down rather than printing one number: this is the amount a
 * tenant will be billed every month for the whole term, and "1,100" with no
 * working is the kind of figure people accept and then have to reconstruct
 * from an invoice months later.
 */
export function ContractMonthlyTotalCard({
  units,
  extraCharges,
  categories,
  labels,
}: ContractMonthlyTotalCardProps) {
  const { locale } = useI18n();
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const rentTotal = monthlyInvoiceTotal(units, []);
  const total = monthlyInvoiceTotal(units, extraCharges);

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-4 sm:col-span-2 lg:col-span-3">
      <p className="text-sm font-semibold">{labels.heading}</p>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{labels.rent}</span>
        <LtrText>{formatKwd(rentTotal, locale)}</LtrText>
      </div>

      {extraCharges.map((charge, index) => {
        const category = categoryById.get(charge.category_id);
        // An unnamed row is one the operator has not finished; showing the
        // amount against a blank label is clearer than hiding it and letting
        // the total not add up.
        const name = category
          ? locale === "ar"
            ? category.name_ar
            : (category.name_en ?? category.name_ar)
          : "—";
        return (
          <div
            key={`${charge.category_id || "unset"}-${index}`}
            className="flex items-center justify-between text-sm"
          >
            <span className="text-muted-foreground">{name}</span>
            <LtrText>{formatKwd(Number(charge.amount) || 0, locale)}</LtrText>
          </div>
        );
      })}

      <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
        <span>{labels.total}</span>
        <LtrText>{formatKwd(total, locale)}</LtrText>
      </div>
    </div>
  );
}
