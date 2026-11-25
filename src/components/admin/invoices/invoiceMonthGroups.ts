import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import type { Locale } from "@/i18n/dictionary";
import type { InvoiceState } from "@/integrations/supabase/database.types";
import { propertyDisplayName } from "@/lib/propertyDisplayName";

export type InvoicePropertyGroup = {
  label: string;
  propertyId: string | null;
  rows: InvoiceWithRelations[];
};

/**
 * لون شارة حالة الفاتورة في جدول الشهر — المتأخرة تومض حتى لا تُقرأ كصف عادي.
 */
export function invoiceMonthStateClass(state: InvoiceState) {
  if (state === "overdue")
    return "border-red-200 bg-red-100 text-red-800 animate-pulse shadow-[0_0_0_1px_rgba(220,38,38,0.35)]";
  if (state === "paid") return "border-emerald-200 bg-emerald-100 text-emerald-800";
  if (state === "partially_paid") return "border-amber-200 bg-amber-100 text-amber-800";
  if (state === "cancelled" || state === "waived")
    return "border-slate-200 bg-slate-100 text-slate-700";
  return "border-sky-200 bg-sky-100 text-sky-800";
}

/**
 * يجمع فواتير الصفحة حسب مجموعة العقارات التي تغطيها، لا حسب عقار واحد.
 *
 * A multi-unit contract can span several properties; picking one building
 * would file the invoice under a complex it only partly belongs to.
 */
export function groupInvoicesByProperty(
  invoices: InvoiceWithRelations[],
  locale: Locale,
  unlabeled: string,
): InvoicePropertyGroup[] {
  const result = new Map<string, InvoicePropertyGroup>();
  for (const invoice of invoices) {
    const key = invoice.properties.length
      ? invoice.properties
          .map((property) => property.id)
          .sort()
          .join("+")
      : "unassigned";
    const current = result.get(key) ?? {
      propertyId: invoice.properties.length === 1 ? invoice.properties[0].id : null,
      label:
        invoice.properties.map((property) => propertyDisplayName(property, locale)).join(" + ") ||
        unlabeled,
      rows: [],
    };
    current.rows.push(invoice);
    result.set(key, current);
  }
  return [...result.values()];
}
