import type { Json } from "@/integrations/supabase/database.types";
import { constantTimeEquals, decodeBase64, hmacBase64 } from "@/lib/webhookSignature";

/*
 * التحقق من توقيع ويب هوك ماي فاتورة: النص المعياري والمطابقة.
 *
 * Split out of `fns/myfatoorahWebhook.ts` (audit M2) because it is a pure
 * function of the payload and the secret — no database, no settlement — and
 * it is the one part of the webhook a wrong edit silently breaks: a signature
 * that stops matching looks exactly like a forged one.
 */

/** هل القيمة كائن عادي (لا مصفوفة ولا null)؟ */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ترتيب الحقول الذي توقّع عليه ماي فاتورة، لكل نوع حدث على حدة.
 *
 * MyFatoorah does **not** sign the request body. It signs a canonical
 * `key=value,key2=value2` string built from named properties of `Data`, in a
 * documented order that differs per event type, with nulls rendered as empty
 * strings. Signing the body — which this did until 2026-08-09 — cannot ever
 * match, and rejected five real webhooks including a 2,390 KWD KNET payment.
 * https://docs.myfatoorah.com/docs/webhook-signature
 *
 * Listed here are the three types whose order is published and which this
 * merchant actually receives. An unlisted type is reported as unverifiable
 * rather than signed with a guessed order: a wrong order is indistinguishable
 * from a forged signature, so guessing would turn a loud failure into a silent
 * one.
 */
const SIGNATURE_FIELDS_BY_EVENT: Record<string, readonly string[]> = {
  PAYMENT_STATUS_CHANGED: [
    "Invoice.Id",
    "Invoice.Status",
    "Transaction.Status",
    "Transaction.PaymentId",
    "Invoice.ExternalIdentifier",
  ],
  REFUND_STATUS_CHANGED: [
    "Refund.Id",
    "Refund.Status",
    "Amount.ValueInBaseCurrency",
    "ReferencedInvoice.Id",
  ],
  BALANCE_TRANSFERRED: [
    "Deposit.Reference",
    "Deposit.ValueInBaseCurrency",
    "Deposit.NumberOfTransactions",
  ],
};

/**
 * يقرأ قيمة لبناء نص التوقيع؛ الغائب يُكتب سلسلة فارغة.
 *
 * Deliberately *not* `nestedString` in `fns/myfatoorahWebhook.ts`, despite walking the same shape. That
 * one returns null and trims, which is right for extracting a value we may not
 * have; this one must render an absent field as `""` and must not trim, because
 * the output is hashed and any deviation changes the signature. Merging them
 * would silently break verification.
 */
function valueAtPath(data: Record<string, unknown>, path: string): string {
  let cursor: unknown = data;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) return "";
    cursor = cursor[segment];
  }
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);
  // Null, undefined, objects and arrays all render as empty, per the spec's
  // "if a parameter has no value, set its value to an empty string".
  return "";
}

/**
 * يبني النص المعياري الذي توقّع عليه ماي فاتورة، أو null إن كان نوع الحدث غير معروف.
 */
export function canonicalSignatureString(payload: Json): string | null {
  const root = isRecord(payload) ? payload : {};
  const event = isRecord(root.Event) ? root.Event : {};
  const eventName = typeof event.Name === "string" ? event.Name : null;
  const fields = eventName ? SIGNATURE_FIELDS_BY_EVENT[eventName] : undefined;
  if (!fields) return null;
  const data = isRecord(root.Data) ? root.Data : {};
  return fields.map((path) => `${path}=${valueAtPath(data, path)}`).join(",");
}

/** كيف قُرئ المفتاح السري عند المطابقة. */
type KeyEncoding = "utf8" | "base64-decoded";

/** نتيجة التحقق من توقيع ماي فاتورة. */
export interface SignatureCheck {
  canonical: string | null;
  matchedKeyEncoding: KeyEncoding | null;
  valid: boolean;
}

/**
 * يتحقق من توقيع ماي فاتورة مقابل النص المعياري لهذا النوع من الأحداث.
 *
 * The secret is tried both as its literal characters and base64-decoded. The
 * spec says only "with the secret key from the portal in binary mode", which
 * does not say which, and the portal issues a base64-looking string — so the
 * two readings are equally defensible and cannot be told apart without a real
 * delivery. Trying both costs one extra HMAC and gives up nothing: a forger
 * still needs the secret either way. `matchedKeyEncoding` records the answer
 * the first real webhook gives us, so this can be narrowed to one.
 */
export async function verifySignature(
  payload: Json,
  suppliedSignature: string | null,
  secret: string,
): Promise<SignatureCheck> {
  const canonical = canonicalSignatureString(payload);
  if (!suppliedSignature || canonical === null) {
    return { canonical, matchedKeyEncoding: null, valid: false };
  }
  const signature = suppliedSignature.replace(/^Bearer\s+/i, "").trim();
  const decodedSecret = decodeBase64(secret);
  const keysByEncoding: Array<[KeyEncoding, Uint8Array]> = [
    ["utf8", new TextEncoder().encode(secret)],
  ];
  if (decodedSecret) keysByEncoding.push(["base64-decoded", decodedSecret]);
  for (const [encoding, keyBytes] of keysByEncoding) {
    if (constantTimeEquals(await hmacBase64(keyBytes, canonical), signature)) {
      return { canonical, matchedKeyEncoding: encoding, valid: true };
    }
  }
  return { canonical, matchedKeyEncoding: null, valid: false };
}
