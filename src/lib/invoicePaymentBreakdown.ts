import { dictionaries, type Locale } from "@/i18n/dictionary";
import type { Json } from "@/integrations/supabase/database.types";
import { formatKwd } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethodLabels";

export type InvoicePaymentSource = "partial" | "gateway" | "manual";

export type InvoicePaymentBreakdownGroup = {
  amount: number;
  first_paid_on: string;
  /** Latest payment in the group (migration 227); the one that settled it. */
  last_paid_on: string;
  method: string;
  payments: number;
  source: InvoicePaymentSource;
};

export type InvoicePaymentBreakdownTotals = {
  balance: number;
  code: string;
  discount: number;
  paid: number;
  state: string;
  subtotal: number;
  total: number;
};

export type InvoicePaymentBreakdown = {
  groups: InvoicePaymentBreakdownGroup[];
  invoice: InvoicePaymentBreakdownTotals;
  paid_from_allocations: number;
  reconciled: boolean;
};

/**
 * قراءة لقطة السداد القادمة من jsonb وتحويلها إلى أرقام حقيقية.
 *
 * Lives beside the types rather than in the hook so the emailed invoice paper
 * parses the same snapshot the screens do — the hook imports the browser
 * Supabase client, which a server function must not pull in.
 */
const SOURCES = new Set<InvoicePaymentSource>(["partial", "gateway", "manual"]);

/**
 * يحوّل jsonb اللقطة إلى أرقام حقيقية.
 *
 * Postgres numeric arrives as a string through json. Summing those on the
 * client would concatenate, and the document would print the wrong remaining.
 */
function asNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new Error("invoice_payment_breakdown_invalid");
  return numeric;
}

/**
 * يتحقق من شكل مجموعة التخصيص قبل رسمها على المستند.
 */
function asGroup(value: unknown): InvoicePaymentBreakdownGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invoice_payment_breakdown_invalid");
  }
  const row = value as Record<string, unknown>;
  if (!SOURCES.has(row.source as InvoicePaymentSource)) {
    throw new Error("invoice_payment_breakdown_invalid");
  }
  const firstPaidOn = typeof row.first_paid_on === "string" ? row.first_paid_on : "";
  return {
    source: row.source as InvoicePaymentSource,
    method: typeof row.method === "string" ? row.method : "",
    amount: asNumber(row.amount),
    first_paid_on: firstPaidOn,
    // A snapshot from before migration 227 has no `last_paid_on`; for the
    // minutes between the schema change and the new bundle, its first date is
    // the closest truthful answer.
    last_paid_on: typeof row.last_paid_on === "string" ? row.last_paid_on : firstPaidOn,
    payments: asNumber(row.payments),
  };
}

/**
 * تاريخ سداد الفاتورة: آخر دفعة مؤكدة عليها، أو null إن لم تُدفع بعد.
 *
 * The latest across groups because the payment that completes an invoice is
 * the one its "paid on" date refers to. ISO strings compare correctly as text.
 */
export function invoicePaidOn(breakdown: InvoicePaymentBreakdown): string | null {
  const dates = breakdown.groups.map((group) => group.last_paid_on).filter(Boolean);
  return dates.length ? dates.reduce((latest, date) => (date > latest ? date : latest)) : null;
}

/**
 * يحوّل استجابة RPC اللقطة إلى النوع الذي يحتاجه المستند.
 */
export function parseInvoicePaymentBreakdown(payload: Json | null): InvoicePaymentBreakdown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invoice_payment_breakdown_missing");
  }
  const row = payload as Record<string, unknown>;
  const invoiceRaw = row.invoice;
  if (!invoiceRaw || typeof invoiceRaw !== "object" || Array.isArray(invoiceRaw)) {
    throw new Error("invoice_payment_breakdown_invalid");
  }
  const invoice = invoiceRaw as Record<string, unknown>;
  const groupsRaw = Array.isArray(row.groups) ? row.groups : [];
  return {
    invoice: {
      code: typeof invoice.code === "string" ? invoice.code : "",
      subtotal: asNumber(invoice.subtotal),
      discount: asNumber(invoice.discount),
      total: asNumber(invoice.total),
      paid: asNumber(invoice.paid),
      balance: asNumber(invoice.balance),
      state: typeof invoice.state === "string" ? invoice.state : "",
    },
    paid_from_allocations: asNumber(row.paid_from_allocations),
    reconciled: Boolean(row.reconciled),
    groups: groupsRaw.map(asGroup),
  };
}

export type BreakdownGroupRow = {
  amount: number;
  label: string;
};

export type DescribedBreakdown = {
  distinctMethodCount: number;
  groupRows: BreakdownGroupRow[];
  showBreakdown: boolean;
  statusLine: string;
};

const GROUP_LABEL_KEY: Record<InvoicePaymentSource, string> = {
  partial: "invoiceDocument.paidGroupPartial",
  gateway: "invoiceDocument.paidGroupGateway",
  manual: "invoiceDocument.paidGroupManual",
};

/**
 * يستبدل عناصر القالب {name} بقيمها.
 *
 * Dictionary strings carry placeholders rather than concatenating fragments,
 * so Arabic dual/plural can be whole sentences.
 */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");
}

/**
 * يقرأ مفتاحًا من قاموس اللغة مباشرة، لأن مستند الطباعة يُبنى خارج React.
 *
 * Shared with `invoicePrintHtml.ts`; the two documents must never resolve the
 * same key two different ways.
 */
export function documentCopy(locale: Locale, key: string): string {
  return dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
}

/**
 * يصف لقطة السداد: صفوف المجموعات، عدد الطرق المميّزة، وسطر الحالة.
 *
 * Distinct *methods* drive the "using N payment methods" clause — groups are
 * provenance, so two cash groups (partial + manual) are still one method.
 * When `reconciled` is false the breakdown is withheld: the stored `paid` is
 * what the document must print, and the groups would be the wrong picture —
 * including their method count, or "paid in full, using 2 payment methods"
 * would still present the mismatched allocations as the explanation.
 */
export function describeBreakdown(
  payload: InvoicePaymentBreakdown,
  locale: Locale,
): DescribedBreakdown {
  const showBreakdown = payload.reconciled && payload.groups.length > 0;
  const distinctMethodCount = showBreakdown
    ? new Set(payload.groups.map((group) => group.method)).size
    : 0;
  const groupRows = showBreakdown
    ? payload.groups.map((group) => ({
        amount: group.amount,
        label: fill(documentCopy(locale, GROUP_LABEL_KEY[group.source]), {
          method: paymentMethodLabel(group.method, locale),
        }),
      }))
    : [];

  return {
    distinctMethodCount,
    groupRows,
    showBreakdown,
    statusLine: statusLineFor(payload, locale, distinctMethodCount),
  };
}

/**
 * يبني سطر حالة الفاتورة من لقطة السداد، لا من صف الفاتورة في الواجهة.
 *
 * Totals come from the snapshot so a stale list row cannot print "paid in
 * full" against a remaining balance the RPC just returned.
 */
function statusLineFor(
  payload: InvoicePaymentBreakdown,
  locale: Locale,
  distinctMethodCount: number,
): string {
  const { invoice } = payload;
  if (invoice.state === "cancelled") return documentCopy(locale, "invoiceDocument.cancelled");
  if (invoice.state === "waived") return documentCopy(locale, "invoiceDocument.writtenOff");
  if (Number(invoice.total) === 0) return documentCopy(locale, "invoiceDocument.nothingDue");
  if (invoice.state === "paid") {
    if (distinctMethodCount >= 2) {
      if (locale === "ar" && distinctMethodCount === 2) {
        return documentCopy(locale, "invoiceDocument.paidInFullUsingDual");
      }
      return fill(documentCopy(locale, "invoiceDocument.paidInFullUsingPlural"), {
        n: String(distinctMethodCount),
      });
    }
    return documentCopy(locale, "invoiceDocument.paidInFull");
  }
  // Money, not state: an overdue invoice that has received a partial payment
  // reads `overdue` (migrations 217/218), and printing "unpaid" on it would
  // contradict the partially-paid indicator the tables show.
  if (invoice.paid > 0 && invoice.balance > 0) {
    return fill(documentCopy(locale, "invoiceDocument.partiallyPaidRemaining"), {
      amount: formatKwd(invoice.balance, locale),
    });
  }
  return documentCopy(locale, "invoiceDocument.unpaid");
}
