import type { SupabaseClient } from "@supabase/supabase-js";

import { serverCompanyClient } from "@/company/companyClient.server";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import type { Company } from "@/hooks/useCompany";
import { t, type Locale } from "@/i18n/dictionary";
import type { Database, Tables } from "@/integrations/supabase/database.types";
import { fetchInChunks } from "@/lib/idChunks";
import {
  EXTRA_CHARGE_ITEM_COLUMNS,
  resolveExtraChargesByInvoice,
  type ExtraChargeLine,
} from "@/lib/invoiceExtraCharges";
import {
  parseInvoicePaymentBreakdown,
  type InvoicePaymentBreakdown,
} from "@/lib/invoicePaymentBreakdown";
import {
  loadInvoicesWithRelations,
  withoutRelations,
  type InvoiceWithRelations,
} from "@/lib/invoiceRelations";
import { buildPaymentDocument, settledInvoicesOf } from "@/lib/paymentPrintDocument";
import type { ReceiptIdentity } from "@/lib/paymentReceiptHtml";
import type { PartyNameTenant } from "@/lib/partyName";
import { renderAndStorePdf, type StoredPdf } from "@/lib/reportPdfAttachment";

/**
 * مستند الدفعة كملف PDF مرفق برسائل "تم استلام الدفعة".
 *
 * The emailed document goes through `buildPaymentDocument` — the same selector
 * the admin payments dialog and the tenant portal's payment row call — so the
 * mail carries the paper the platform prints rather than one of its own. That
 * selector prints the settled INVOICE sheet when the payment settled invoices
 * and the payment-receipt sheet only when it settled none, which is exactly the
 * choice the two screens make.
 *
 * This is the third time this document has been unified and the reason it kept
 * drifting is that the email assembled its own: the invoice sheet needs the
 * invoice's relations and its payment snapshot, and both loaders were bound to
 * the browser Supabase client. They take a client as a parameter now
 * (`loadInvoicesWithRelations`, `parseInvoicePaymentBreakdown`), so there is one
 * renderer, one selector, and one set of inputs behind all three surfaces.
 */

/** Path prefix inside `report-documents`; see {@link renderPaymentReceiptPdfs}. */
const RECEIPT_PREFIX = "payment-receipts";

/**
 * A stored receipt plus the filename its recipient should see, and the payment
 * it belongs to — which is how a caller tells a payment whose PDF could not be
 * rendered apart from one that rendered.
 */
export type StoredReceiptPdf = StoredPdf & { displayName: string; paymentId: string };

/** The issued `receipts` row in the shape {@link buildPaymentDocument} takes. */
type ReceiptRow = ReceiptIdentity &
  Pick<Tables<"receipts">, "id" | "amount" | "currency" | "payment_id">;

/**
 * يجلب بنود المصروفات لفواتير الدفعات، على دفعات، وبلا رمي استثناء.
 *
 * `fetchInChunks` buys two things a bare `in()` cannot. It keeps the request
 * line under the gateway's 8 KB ceiling, and — the one that matters here — it
 * splits a response that reached `PGRST_MAX_ROWS` instead of handing back the
 * clip as though it were the whole answer. 200 invoices carry up to 2,800 line
 * items in this database, so a multi-month settlement reaches that cap, and the
 * clip arrives with no error and no flag: `resolveExtraChargesByInvoice` would
 * read every dropped row as a charge that was never billed, and the emailed
 * receipt would quietly understate what the tenant paid.
 *
 * It throws where this module must not, so the throw is caught right here. A
 * receipt missing its service-charge column is a degradation; a receipt that
 * never goes out is an outage, and the money has already moved by this point.
 * Broad on purpose, and narrow in reach: nothing but this one lookup is inside
 * the `try`, so a failure anywhere else still surfaces.
 */
async function fetchExtraCharges(
  client: SupabaseClient<Database>,
  invoiceIds: string[],
): Promise<Map<string, ExtraChargeLine[]>> {
  if (!invoiceIds.length) return new Map();
  try {
    const rows = await fetchInChunks(invoiceIds, (chunk) =>
      client.from("invoice_items").select(EXTRA_CHARGE_ITEM_COLUMNS).in("invoice_id", chunk),
    );
    return resolveExtraChargesByInvoice(rows);
  } catch (error) {
    console.error("[paymentReceiptPdf] invoice items query failed", error);
    return new Map();
  }
}

/**
 * يجلب تخصيصات الدفعات مع فواتيرها، باستعلام واحد لكل الدفعات.
 */
async function fetchAllocationsWithInvoices(
  client: SupabaseClient<Database>,
  paymentIds: string[],
): Promise<AllocationWithInvoice[]> {
  const allocationsResult = await client
    .from("payment_allocations")
    .select("*")
    .in("payment_id", paymentIds)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (allocationsResult.error) {
    console.error("[paymentReceiptPdf] allocations query failed", allocationsResult.error.message);
  }

  const allocations = allocationsResult.data ?? [];
  const invoiceIds = [...new Set(allocations.map((allocation) => allocation.invoice_id))];
  const invoiceResult = invoiceIds.length
    ? await client.from("invoices").select("*").in("id", invoiceIds)
    : { data: [] as Tables<"invoices">[], error: null };
  if (invoiceResult.error) {
    console.error("[paymentReceiptPdf] invoices query failed", invoiceResult.error.message);
  }

  const invoiceById = new Map(
    (invoiceResult.data ?? []).map((invoice) => [invoice.id, invoice] as const),
  );

  const extraChargesFor = await fetchExtraCharges(client, invoiceIds);

  return allocations.map((allocation) => ({
    ...allocation,
    invoice: invoiceById.get(allocation.invoice_id) ?? null,
    extraCharges: extraChargesFor.get(allocation.invoice_id) ?? [],
  }));
}

/**
 * يجمّع التخصيصات حسب الدفعة، فلكل إيصال تخصيصاته وحده.
 *
 * The single query above returns every payment's allocations interleaved.
 * Grouping is what stops one receipt from listing another payment's invoices.
 */
function groupByPaymentId(
  allocations: AllocationWithInvoice[],
): Map<string, AllocationWithInvoice[]> {
  const byPayment = new Map<string, AllocationWithInvoice[]>();
  for (const allocation of allocations) {
    const forPayment = byPayment.get(allocation.payment_id);
    if (forPayment) forPayment.push(allocation);
    else byPayment.set(allocation.payment_id, [allocation]);
  }
  return byPayment;
}

/**
 * يجلب لقطة السداد لكل فاتورة سدّدتها الدفعة، وهي ما تطبعه ورقة الفاتورة.
 *
 * One RPC per invoice, because `get_invoice_payment_breakdown` takes a single
 * id — the same call the portal's payment row makes. It is issued in bounded
 * batches rather than one at a time or all at once: an all-contracts checkout
 * notifies for every payment it created, and the settled set reaches the
 * hundreds (`paymentReceiptPdf.test.ts` exercises 250), which is both too many
 * to await in series inside a notification and too many to fire at one
 * Postgres.
 *
 * An invoice whose snapshot could not be read is simply absent from the map,
 * and {@link renderPaymentReceiptPdfs} treats that as "this payment gets no
 * attachment" rather than printing a page with an empty payments section — an
 * invoice sheet missing the very rows it exists to show would be a third
 * document again.
 */
const BREAKDOWN_BATCH_SIZE = 8;

async function fetchBreakdowns(
  client: SupabaseClient<Database>,
  invoiceIds: string[],
): Promise<Map<string, InvoicePaymentBreakdown>> {
  const breakdowns = new Map<string, InvoicePaymentBreakdown>();
  for (let start = 0; start < invoiceIds.length; start += BREAKDOWN_BATCH_SIZE) {
    const batch = invoiceIds.slice(start, start + BREAKDOWN_BATCH_SIZE);
    const snapshots = await Promise.all(
      batch.map((invoiceId) => fetchBreakdown(client, invoiceId)),
    );
    for (const [invoiceId, snapshot] of snapshots) {
      if (snapshot) breakdowns.set(invoiceId, snapshot);
    }
  }
  return breakdowns;
}

/**
 * يجلب لقطة سداد فاتورة واحدة، ويعيد null عند الفشل بعد تسجيله.
 */
async function fetchBreakdown(
  client: SupabaseClient<Database>,
  invoiceId: string,
): Promise<readonly [string, InvoicePaymentBreakdown | null]> {
  try {
    const { data, error } = await client.rpc("get_invoice_payment_breakdown", {
      p_invoice_id: invoiceId,
    });
    if (error) throw new Error(error.message);
    return [invoiceId, parseInvoicePaymentBreakdown(data)];
  } catch (error) {
    console.error("[paymentReceiptPdf] payment breakdown failed", invoiceId, error);
    return [invoiceId, null];
  }
}

/**
 * يحمّل علاقات الفواتير المسدَّدة، وبلا رمي استثناء.
 */
async function fetchInvoiceRelations(
  client: SupabaseClient<Database>,
  invoices: Tables<"invoices">[],
): Promise<Map<string, InvoiceWithRelations>> {
  if (!invoices.length) return new Map();
  try {
    const enriched = await loadInvoicesWithRelations(client, invoices);
    return new Map(enriched.map((invoice) => [invoice.id, invoice] as const));
  } catch (error) {
    console.error("[paymentReceiptPdf] invoice relations query failed", error);
    return new Map(invoices.map((invoice) => [invoice.id, withoutRelations(invoice)] as const));
  }
}

/**
 * يحمّل كل ما يحتاجه بناء الإيصال: التخصيصات مجمّعة وبيانات الشركة والمستأجر.
 */
async function loadReceiptContext(
  client: SupabaseClient<Database>,
  companyId: string,
  paymentIds: string[],
  tenantId: string | null,
): Promise<{
  allocationsByPayment: Map<string, AllocationWithInvoice[]>;
  breakdowns: Map<string, InvoicePaymentBreakdown>;
  company: Company | null;
  invoicesById: Map<string, InvoiceWithRelations>;
  receiptByPayment: Map<string, ReceiptRow>;
  tenant: PartyNameTenant | null;
}> {
  const tenantQuery = tenantId
    ? client
        .from("tenants")
        .select("commercial_name, commercial_name_ar, commercial_name_en, name, name_en")
        .eq("id", tenantId)
        .maybeSingle()
    : Promise.resolve({ data: null as PartyNameTenant | null, error: null });

  const [allocations, companyResult, tenantResult, receiptResult] = await Promise.all([
    fetchAllocationsWithInvoices(client, paymentIds),
    client.from("companies").select("*").eq("id", companyId).maybeSingle(),
    tenantQuery,
    client
      .from("receipts")
      .select("id, code, issue_date, amount, currency, payment_id")
      .in("payment_id", paymentIds),
  ]);
  if (companyResult.error) {
    console.error("[paymentReceiptPdf] company query failed", companyResult.error.message);
  }
  if (tenantResult.error) {
    console.error("[paymentReceiptPdf] tenant query failed", tenantResult.error.message);
  }
  if (receiptResult.error) {
    console.error("[paymentReceiptPdf] receipts query failed", receiptResult.error.message);
  }

  const settled = settledInvoicesOf(allocations);
  const [invoicesById, breakdowns] = await Promise.all([
    fetchInvoiceRelations(client, settled),
    fetchBreakdowns(
      client,
      settled.map((invoice) => invoice.id),
    ),
  ]);

  return {
    allocationsByPayment: groupByPaymentId(allocations),
    breakdowns,
    company: companyResult.data ?? null,
    invoicesById,
    receiptByPayment: new Map(
      (receiptResult.data ?? []).map((row) => [row.payment_id, row] as const),
    ),
    tenant: tenantResult.data ?? null,
  };
}

/**
 * يبني ملف PDF لكل دفعة مؤكدة ويعيد مواضع تخزينها.
 *
 * One document per payment rather than one per email. The notification builder
 * handles a *set* of payments — a multi-month payment link settles several
 * invoice months at once — and each of those is its own receipt with its own
 * code, date and allocations. `attachment_paths` is a list and the dispatcher
 * loops over it, so several receipts ride one message without a second
 * mechanism.
 *
 * Stored under `payment-receipts/` in the existing private `report-documents`
 * bucket. Migration 109's policy matches on `bucket_id`, not on a path, so a
 * new prefix needs no policy and no migration.
 *
 * Each entry carries a `displayName`: the stored key ends in a payment id and a
 * content hash to keep the upload idempotent, which is not a name a tenant can
 * match to the receipt they hold. The dispatcher attaches the display name and
 * keeps the key.
 *
 * Never throws. A payment whose PDF could not be rendered is simply absent from
 * the returned list and its email goes out as HTML — losing an attachment is a
 * degradation, losing a receipt is an outage. `renderAndStorePdf` already logs
 * every failure it swallows.
 *
 * A payment that settled invoices whose relations or snapshots could not be
 * loaded is deliberately in that "no attachment" set rather than falling back
 * to the receipt sheet. Falling back is how the mail ended up carrying a
 * different document from the platform in the first place: a fallback of a
 * *different design* is not a degradation, it is the bug.
 */
export async function renderPaymentReceiptPdfs(input: {
  companyId?: string;
  locale: Locale;
  manualPaymentReason: string | null;
  payments: Tables<"payments">[];
}): Promise<StoredReceiptPdf[]> {
  if (!input.payments.length) return [];

  const { companyId, client } = serverCompanyClient(
    input.companyId ?? input.payments[0]?.company_id,
  );
  const { allocationsByPayment, breakdowns, company, invoicesById, receiptByPayment, tenant } =
    await loadReceiptContext(
      client,
      companyId,
      input.payments.map((payment) => payment.id),
      input.payments[0]?.tenant_id ?? null,
    );

  const rendered = await Promise.all(
    input.payments.map((payment) =>
      renderOnePayment(payment, {
        allocations: allocationsByPayment.get(payment.id) ?? [],
        breakdowns,
        company,
        companyId,
        invoicesById,
        locale: input.locale,
        manualPaymentReason: input.manualPaymentReason,
        // The number the tenant will quote back, and the one the office copy
        // and the portal download are both headed with. Absent only if the
        // receipt trigger has not fired yet, in which case the payment code
        // stands in.
        receipt: receiptByPayment.get(payment.id) ?? null,
        tenant,
      }),
    ),
  );

  return rendered.filter((document): document is StoredReceiptPdf => document !== null);
}

/**
 * يبني ورقة دفعة واحدة ويخزّنها، ويعيد null إن لم يكن هناك ما يُرفَق.
 *
 * The document itself is chosen by `buildPaymentDocument`, so all this decides
 * is whether the inputs it needs are complete.
 */
async function renderOnePayment(
  payment: Tables<"payments">,
  context: {
    allocations: AllocationWithInvoice[];
    breakdowns: Map<string, InvoicePaymentBreakdown>;
    company: Company | null;
    companyId: string;
    invoicesById: Map<string, InvoiceWithRelations>;
    locale: Locale;
    manualPaymentReason: string | null;
    receipt: ReceiptRow | null;
    tenant: PartyNameTenant | null;
  },
): Promise<StoredReceiptPdf | null> {
  const settled = settledInvoicesOf(context.allocations);
  const invoices = settled
    .map((invoice) => context.invoicesById.get(invoice.id))
    .filter((invoice): invoice is InvoiceWithRelations => invoice != null)
    .filter((invoice) => context.breakdowns.has(invoice.id));

  // Refused here rather than left to the selector, which reads an empty list
  // against a non-empty settlement as the portal's "suppressed, print nothing"
  // and would therefore drop the attachment without saying why.
  if (invoices.length !== settled.length) {
    console.error(
      "[paymentReceiptPdf] settled invoices are missing relations or a payment snapshot; no attachment",
      payment.code,
    );
    return null;
  }

  const printable = buildPaymentDocument({
    allocations: context.allocations,
    breakdowns: context.breakdowns,
    company: context.company,
    invoiceFallbackTitle: t(context.locale, "invoices.printInvoice"),
    invoices,
    locale: context.locale,
    manualPaymentReason: context.manualPaymentReason,
    payment,
    receipt: context.receipt,
    receiptFallbackTitle: t(context.locale, "receipts.title"),
    tenant: context.tenant,
  });
  if (!printable) return null;

  const stored = await renderAndStorePdf({
    // The document's own direction, not the locale's: the invoice sheet is RTL
    // whatever language it is read in, and `wrapHtmlForPdf` puts this on the
    // `<html>` element the receipt's own `dir` sits inside.
    arabic: printable.dir === "rtl",
    companyId: context.companyId,
    // The id, not the code: it is the one value that cannot collide, and it
    // makes the upload idempotent — a re-render of the same payment overwrites
    // its own object instead of littering the bucket.
    discriminator: payment.id,
    html: printable.html,
    name: context.receipt?.code ?? payment.code,
    prefix: RECEIPT_PREFIX,
  });
  return stored ? { ...stored, displayName: printable.filename, paymentId: payment.id } : null;
}
