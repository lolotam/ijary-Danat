import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, Tables } from "@/integrations/supabase/database.types";
import { roundToFils } from "@/lib/fils";

import type { HostedPaymentMethod, PortalInvoice } from "./createPayment";

/*
 * حجز طلب الدفع: متى يُعاد استخدام رابط دفع قائم ومتى يُصدَر رابط جديد.
 *
 * Split out of `createPayment.ts` when it passed the file ceiling (Phase 2C,
 * PR B). `createPayment` decides who may pay what; this file decides which
 * `payment_requests` row — and which live MyFatoorah link — that payment uses.
 *
 * One row is one link. A link is never replaced on its own row: a stale or
 * mismatched pending request is marked `superseded` and a new row carries the
 * new link (migration 223). Resetting in place cleared the provider ids, so a
 * tenant paying the old link — still payable at the gateway — matched no
 * request and the charge was recorded nowhere. A superseded row keeps its ids,
 * settles through the normal path, and the reconcile job keeps polling it.
 */

/**
 * عمر رابط الدفع الأقصى بالساعات قبل إصدار رابط جديد.
 *
 * A link handed out yesterday for an amount that was right yesterday is the
 * shape behind the gateway-overpayment incidents (Phase 2C): months get paid
 * another way while the tenant still holds the old link. MyFatoorah's
 * `/v3/payments` documents no expiry field, so this bounds reuse only — an
 * already-sent link stays payable at the gateway for its own lifetime.
 */
export const PAYMENT_LINK_TTL_HOURS = 24;

const IN_FLIGHT = "A payment request for these invoices is already being created.";

/**
 * يحدد إن كان الطلب ما زال ضمن مدة صلاحية رابطه.
 *
 * Measured from the row's `created_at`: a row is created immediately before
 * its one gateway call and never re-issued, so its age is its link's age.
 */
export function linkIsFresh(createdAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(createdAt) < PAYMENT_LINK_TTL_HOURS * 60 * 60 * 1000;
}

/** اختيار الفواتير المراد دفعها ومجموع أرصدتها. */
export interface InvoiceSelection {
  invoiceIds: string[];
  invoices: PortalInvoice[];
  total: number;
}

/** ما يحتاجه الحجز: اختيار الفواتير ومن يدفع وبأي طريقة. */
interface ReservationInput {
  selection: InvoiceSelection;
  tenantId: string;
  userId: string;
  paymentMethod?: HostedPaymentMethod;
}

/** نتيجة الحجز: الصف المستخدم، وهل رابطه القائم صالح لإعادة الاستخدام. */
interface Reservation {
  request: Tables<"payment_requests">;
  reused: boolean;
}

/**
 * يبني مفتاح عدم التكرار لطلب الدفع من المستأجر والفواتير المختارة.
 *
 * Keyed on tenant + invoices only — deliberately **not** on the payment method.
 *
 * Including the method would let a KNET request and an all-methods request for
 * the same invoices both be pending at once, so the same money could be
 * requested twice. The key is unique, so at most one row holds it; a row gives
 * it up when it stops being the selection's pending request (see
 * `retireRequest`), which makes the guarantee "one PENDING request per
 * selection" rather than one row.
 */
async function idempotencyKey(tenantId: string, invoiceIds: string[]) {
  const bytes = new TextEncoder().encode(`${tenantId}:${invoiceIds.join(",")}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * يقرأ طريقة الدفع المثبّتة على طلب دفع قائم من الحمولة المرسلة إلى البوابة.
 *
 * `saveGatewayExecution` overwrites `request_payload` with the exact body sent
 * to MyFatoorah, so this is the durable record of which method a live payment
 * link was pinned to. It is only meaningful on a row that already carries a
 * `payment_url`, since that is the state proving the gateway call completed and
 * wrote the payload back.
 */
function pinnedPaymentMethod(requestPayload: Json | null): string | undefined {
  if (!requestPayload || typeof requestPayload !== "object" || Array.isArray(requestPayload)) {
    return undefined;
  }
  const method = requestPayload.PaymentMethod;
  return typeof method === "string" ? method : undefined;
}

/** يقرأ الصف الذي يحمل مفتاح الاختيار حالياً، إن وُجد. */
async function requestHoldingKey(requestKey: string) {
  const query = await supabaseAdmin
    .from("payment_requests")
    .select("*")
    .eq("idempotency_key", requestKey)
    .maybeSingle();
  if (query.error) throw new Error(query.error.message);
  return query.data;
}

/**
 * يعيد رابط الصف القائم إن صلح، ويرفض إن كان قيد الإنشاء أو مدفوعاً، ويعيد null إن وجب استبداله.
 *
 * A pending link is reused only while the amount (a month paid another way
 * changes it), the pinned method and the link's age all still fit. A pending
 * row with no link yet is another call's gateway round trip in progress —
 * unless it is past the TTL, when that call evidently died and the row is
 * replaced rather than blocking the selection for good.
 */
function reuseOrRefuse(row: Tables<"payment_requests">, input: ReservationInput) {
  if (row.status === "completed") {
    throw new Error("This invoice selection has already been paid.");
  }
  if (row.status !== "pending") return null;
  const sameCharge = roundToFils(Number(row.amount)) === input.selection.total;
  const fresh = linkIsFresh(row.created_at, new Date());
  if (!row.payment_url) {
    if (sameCharge && fresh) throw new Error(IN_FLIGHT);
    return null;
  }
  const sameMethod = pinnedPaymentMethod(row.request_payload) === input.paymentMethod;
  return sameCharge && sameMethod && fresh ? { request: row, reused: true } : null;
}

/**
 * يُخرج الصف القديم من مفتاح الاختيار، ويعلّمه مُستبدَلاً إن كان معلّقاً.
 *
 * The row keeps its link and provider ids: its link may still be paid, and
 * that charge must find it. Only the key is released, so the new row can take
 * it. Filtering on the key and the status read too makes a concurrent retire of the same row a
 * no-op instead of relabelling a row another call already replaced.
 */
async function retireRequest(row: Tables<"payment_requests">, requestKey: string) {
  const update = await supabaseAdmin
    .from("payment_requests")
    .update({
      idempotency_key: null,
      ...(row.status === "pending" ? { status: "superseded" as const } : {}),
    })
    .eq("id", row.id)
    .eq("idempotency_key", requestKey)
    // Re-asserted in SQL: a row that completed between the read above and this
    // write must not be relabelled `superseded`. The update then matches
    // nothing, the insert hits 23505, and the re-read refuses "already paid".
    .eq("status", row.status);
  if (update.error) throw new Error(update.error.message);
}

/** يُنشئ صف طلب دفع جديداً يحمل مفتاح الاختيار. */
function insertRequest(input: ReservationInput, requestKey: string) {
  return supabaseAdmin
    .from("payment_requests")
    .insert({
      tenant_id: input.tenantId,
      amount: input.selection.total,
      requested_invoice_ids: input.selection.invoiceIds,
      idempotency_key: requestKey,
      created_by: input.userId,
      request_payload: {
        invoice_ids: input.selection.invoiceIds,
        amount: input.selection.total,
        currency: "KWD",
      },
    })
    .select("*")
    .single();
}

/**
 * يحجز طلب الدفع لاختيار الفواتير: يعيد رابطاً صالحاً، أو يستبدل الطلب القديم بطلب جديد.
 *
 * Losing the insert race to a concurrent call is not an error in itself: the
 * winner's row is read back and its link returned when it fits, so two clicks
 * on "pay" yield one link.
 */
export async function reservePaymentRequest(input: ReservationInput): Promise<Reservation> {
  const requestKey = await idempotencyKey(input.tenantId, input.selection.invoiceIds);
  const existing = await requestHoldingKey(requestKey);
  if (existing) {
    const reuse = reuseOrRefuse(existing, input);
    if (reuse) return reuse;
    await retireRequest(existing, requestKey);
  }
  const insertQuery = await insertRequest(input, requestKey);
  if (insertQuery.error?.code === "23505") {
    const winner = await requestHoldingKey(requestKey);
    const reuse = winner ? reuseOrRefuse(winner, input) : null;
    if (reuse) return reuse;
    throw new Error("A payment request for these invoices already exists.");
  }
  if (insertQuery.error) throw new Error(insertQuery.error.message);
  return { request: insertQuery.data, reused: false };
}
