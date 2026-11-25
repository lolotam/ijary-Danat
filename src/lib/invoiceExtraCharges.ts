import { translatorFor } from "@/i18n/dictionary";
import { roundToFils } from "@/lib/fils";

/**
 * المصروفات الدورية على الفاتورة: مجموعها وتصنيفاتها، كما تُطبع على المستندات.
 *
 * A recurring service charge (cleaning, advertising, …) is priced into
 * `invoices.subtotal` by `contract_period_amounts` and written as its own
 * `invoice_items` row by `append_extra_charge_items`, flagged `is_extra_charge`
 * since migration 169. Until now nothing printed read that flag, so a 750 rent
 * plus 20 cleaning reached the tenant as a single 770 with no way to tell the
 * two apart — the reported complaint.
 *
 * The summary is derived from the ITEM ROWS, never from `contract_extra_charges`:
 * the contract's charges are what *future* invoices will bill, and editing one
 * must not retroactively rewrite what a paid invoice says it charged.
 */

/** بند مصروف دوري على الفاتورة، بالأعمدة التي تحتاجها الطباعة فقط. */
export interface ExtraChargeLine {
  amount: number;
  description_ar: string | null;
  description_en: string | null;
}

/** صف بند فاتورة كما يعود من PostgREST، بأقل ما يكفي للتصنيف والترتيب. */
export interface ExtraChargeItemRow extends ExtraChargeLine {
  invoice_id: string;
  is_extra_charge: boolean;
  /**
   * ترتيب البند على الفاتورة، وهو ما يحفظ ترتيب التصنيفات بين الطلبات.
   *
   * `append_extra_charge_items` assigns it from `contract_extra_charges.line_order`,
   * so it is the operator's own ordering.
   */
  line: number;
}

/**
 * أعمدة بنود الفاتورة التي تحتاجها المستندات المطبوعة.
 *
 * Lives here, in a module that imports nothing, rather than beside either
 * caller: the browser hook and the server-side PDF renderer both need it, and
 * importing a runtime value from the hook would drag the browser Supabase
 * client into the server bundle.
 */
export const EXTRA_CHARGE_ITEM_COLUMNS =
  "invoice_id, line, amount, is_extra_charge, description_ar, description_en";

export interface ExtraChargeSummary {
  /** مجموع المصروفات، مقرَّباً إلى ثلاث خانات مثل `numeric(14,3)`. */
  total: number;
  /** تصنيفات المصروف بلغة القارئ، بلا تكرار وبترتيب ظهورها. */
  categories: string[];
}

/**
 * يجمع بنود المصروفات لكل فاتورة من صفوف `invoice_items`، مرتَّبةً بترتيب البند.
 *
 * Rent and concession lines are dropped here rather than filtered in the query
 * because the same fetch also feeds unit attribution, which needs every line.
 *
 * Sorted here rather than trusted from the query: PostgreSQL does not guarantee
 * insertion order for an unordered select, and `fetchInChunks` documents that
 * its ordering holds within a chunk only. Without this, an invoice carrying
 * cleaning and advertising could print "(Cleaning, Advertising)" on one render
 * and "(Advertising, Cleaning)" on the next — two documents for one invoice,
 * which is the drift the printed paper exists to not have.
 */
export function resolveExtraChargesByInvoice(
  items: ReadonlyArray<ExtraChargeItemRow>,
): Map<string, ExtraChargeLine[]> {
  const byInvoice = new Map<string, ExtraChargeItemRow[]>();
  for (const row of items) {
    if (!row.is_extra_charge) continue;
    const lines = byInvoice.get(row.invoice_id) ?? [];
    lines.push(row);
    byInvoice.set(row.invoice_id, lines);
  }
  return new Map(
    [...byInvoice].map(([invoiceId, lines]) => [
      invoiceId,
      lines
        .sort((left, right) => left.line - right.line)
        .map(({ amount, description_ar, description_en }) => ({
          amount,
          description_ar,
          description_en,
        })),
    ]),
  );
}

/**
 * يلخّص بنود المصروفات في مجموع وقائمة تصنيفات.
 *
 * `Number(...)` on every amount: PostgREST returns `numeric` as a string, and
 * `"20" + "15"` is `"2015"`. The finiteness check is not paranoia about a NOT
 * NULL column — it is because the declared `number` type is already known to be
 * a lie on this path, and one NaN would print `NaN KWD` across a whole document
 * rather than failing anywhere a reader could notice.
 *
 * Rounding to three places matches the column's own scale, so a total assembled
 * here and one computed in SQL agree.
 *
 * A line whose description is missing in the reader's language falls back to
 * the other one. `expense_categories.name_en` is nullable (08_phase6) while
 * `name_ar` is not, so an English document is the side that can lose its label,
 * and a blank pair of brackets is a worse answer than the Arabic name.
 */
export function summarizeExtraCharges(
  lines: ReadonlyArray<ExtraChargeLine> | undefined,
  locale: "ar" | "en",
): ExtraChargeSummary {
  const categories: string[] = [];
  let total = 0;
  for (const line of lines ?? []) {
    const amount = Number(line.amount);
    if (Number.isFinite(amount)) total += amount;
    const name =
      locale === "ar"
        ? (line.description_ar ?? line.description_en)
        : (line.description_en ?? line.description_ar);
    if (name && !categories.includes(name)) categories.push(name);
  }
  return { total: roundToFils(total), categories };
}

/**
 * يبني تسمية سطر المصروفات: العنوان ثم التصنيفات بين قوسين.
 *
 * The brackets are the whole point of the field — "Extra expense" alone tells a
 * tenant an amount was added but not what for, which is the question they ring
 * the office about. With no charge on the invoice the label stays bare and the
 * amount prints as zero, because the row appears on every invoice by design:
 * its absence would otherwise read as "this month had none" on exactly the
 * invoices where the office forgot to add one.
 */
export function extraChargeLabel(summary: ExtraChargeSummary, locale: "ar" | "en"): string {
  const t = translatorFor(locale);
  const base = t("invoiceDocument.extraExpense");
  if (!summary.categories.length) return base;
  return `${base} (${summary.categories.join(locale === "ar" ? "، " : ", ")})`;
}
