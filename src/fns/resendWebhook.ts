import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type { Json } from "@/integrations/supabase/database.types";
import { constantTimeEquals, decodeBase64, hmacBase64 } from "@/lib/webhookSignature";

/** الفارق الزمني المسموح به بين ختم الطلب وساعتنا، بالمللي ثانية. */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * أقصى حجم مقبول لجسم الطلب.
 *
 * This endpoint is public and unauthenticated until the signature is checked,
 * so the body is attacker-controlled at the moment it is read. Resend's own
 * events are a few kilobytes; 256 KB is generous for one and small enough that
 * a flood cannot fill the table.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * النافذة التي يُعدّ فيها عدم العثور على الإشعار سباقًا لا غيابًا.
 *
 * `dispatchNotification` writes `provider_message_id` *after* awaiting the send
 * (`:319`), so a bounce that arrives in that gap finds no row yet. Answering
 * 2xx there would tell Svix never to retry, and the bounce would be lost for
 * good — the exact invisible-failure this endpoint exists to prevent. Inside
 * this window a miss is therefore reported as retryable; outside it, the mail
 * genuinely was not sent by this app (someone else using the same Resend
 * account) and retrying forever would eventually get the endpoint disabled.
 */
const EARLY_MISS_WINDOW_MS = 2 * 60 * 1000;

/**
 * الأحداث التي تعني أن الرسالة لن تصل أبدًا، فيُحوَّل الإشعار إلى مراجعة بشرية.
 *
 * Deliberately excludes `email.delivery_delayed` and transient bounces: Resend
 * is still retrying those, and filing a message as dead while it is in flight
 * is a worse lie than saying nothing.
 */
const TERMINAL_EVENTS = new Set([
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
]);

/**
 * أنواع الارتداد المؤقّتة التي ما زال المزوّد يعيد المحاولة عليها.
 *
 * SES — whose classification Resend passes through — uses Permanent, Transient
 * and Undetermined. Only Transient means "may still arrive"; Undetermined means
 * the failure was real but its cause could not be classified, and is retried by
 * nobody. It is treated as terminal so the message does not vanish silently,
 * which is the entire reason this endpoint exists. An absent `bounce.type` is
 * terminal too: Resend documents `email.bounced` itself as a permanent
 * rejection, so the event name is the fallback classification.
 */
const TRANSIENT_BOUNCE_TYPES = new Set(["transient"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(source: unknown, path: string): string | null {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : null;
}

export interface ResendEventDetails {
  /**
   * لحظة وقوع الحدث عند Resend، لا لحظة محاولة التسليم.
   *
   * Read from the payload and never from `svix-timestamp`. Svix re-signs every
   * retry with the current clock — it must, or a retry would fail the five
   * minute staleness check — so the header says when this *attempt* was signed,
   * which is always "just now". Anything that needs the event's real age has to
   * use this, or a retry loop can never age out. Null when the payload carries
   * no parsable `created_at`.
   */
  createdAtMs: number | null;
  emailId: string | null;
  eventType: string | null;
  failureReason: string | null;
  terminal: boolean;
  /**
   * ارتداد مؤقّت تحديدًا، لا مجرد حدث غير نهائي.
   *
   * Kept separate from `terminal` so the archive can say which it was. Filed as
   * plain `ignored_event_type`, a soft bounce is indistinguishable from an
   * `email.opened` — and "was this a soft bounce?" is exactly the question the
   * archive exists to answer.
   */
  transientBounce: boolean;
}

/**
 * يستخرج من حمولة Resend ما يلزم لتحديث الإشعار، ويقرّر إن كان الحدث نهائيًّا.
 *
 * Every field is read defensively. Resend's per-event payload pages were
 * unreachable when this was written, so only `type`, `data.email_id` and
 * `data.bounce.{type,subType,message}` are confirmed shapes; anything else
 * falls back to the event name rather than inventing a field.
 */
export function resendEventDetails(payload: Json): ResendEventDetails {
  const root = isRecord(payload) ? payload : {};
  const eventType = stringAt(root, "type");
  const bounceType = stringAt(root, "data.bounce.type");
  const transientBounce =
    eventType === "email.bounced" && TRANSIENT_BOUNCE_TYPES.has(bounceType?.toLowerCase() ?? "");
  const terminal = Boolean(eventType && TERMINAL_EVENTS.has(eventType) && !transientBounce);
  const detail =
    stringAt(root, "data.bounce.message") ??
    stringAt(root, "data.failed.reason") ??
    stringAt(root, "data.reason");
  const subType = stringAt(root, "data.bounce.subType");
  const createdAt = stringAt(root, "created_at") ?? stringAt(root, "data.created_at");
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  return {
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
    emailId: stringAt(root, "data.email_id"),
    eventType,
    failureReason: eventType
      ? [`Resend reported ${eventType}`, bounceType, subType, detail].filter(Boolean).join(" — ")
      : null,
    terminal,
    transientBounce,
  };
}

export interface SvixHeaders {
  id: string | null;
  signature: string | null;
  timestamp: string | null;
}

/**
 * يقرأ ترويسات Svix، وتُقبل التسمية المعيارية `webhook-*` كذلك.
 *
 * Resend documents the `svix-*` names, but Svix also emits the vendor-neutral
 * `webhook-*` aliases and can be configured to send only those. Reading both
 * costs three header lookups and removes an entire class of "verified locally,
 * 401 in production" failure.
 */
export function svixHeaders(request: Request): SvixHeaders {
  const read = (svix: string, standard: string) =>
    request.headers.get(svix) ?? request.headers.get(standard);
  return {
    id: read("svix-id", "webhook-id"),
    signature: read("svix-signature", "webhook-signature"),
    timestamp: read("svix-timestamp", "webhook-timestamp"),
  };
}

export type SignatureRejection =
  | "missing_headers"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "malformed_secret"
  | "signature_mismatch";

export interface SvixVerification {
  reason: SignatureRejection | null;
  valid: boolean;
}

/**
 * يتحقق من توقيع Svix الذي يرسله Resend مقابل الجسم الخام للطلب.
 *
 * The signed content is `id.timestamp.body` and the key is the `whsec_` secret
 * *base64-decoded* — signing with its literal characters produces a value that
 * never matches, which is the same mistake that left the MyFatoorah webhook
 * rejecting real payments for weeks. The body must be the untouched bytes:
 * re-serialising the parsed JSON changes nothing visible and breaks every
 * signature.
 */
export async function verifySvixSignature(input: {
  headers: SvixHeaders;
  now: number;
  rawBody: string;
  secret: string;
}): Promise<SvixVerification> {
  const { headers, now, rawBody, secret } = input;
  if (!headers.id || !headers.signature || !headers.timestamp) {
    return { reason: "missing_headers", valid: false };
  }

  const seconds = Number(headers.timestamp);
  if (!Number.isFinite(seconds)) return { reason: "malformed_timestamp", valid: false };
  // Rejects a replay of a genuine, correctly-signed delivery captured off the
  // wire; without it that capture stays valid forever.
  if (Math.abs(now - seconds * 1000) > TIMESTAMP_TOLERANCE_MS) {
    return { reason: "stale_timestamp", valid: false };
  }

  // `replace`, not `split("_")[1]`: a secret whose base64 body contained an
  // underscore would be silently truncated to a prefix, and every signature
  // would then mismatch for a reason no log line would explain.
  const keyBytes = decodeBase64(secret.replace(/^whsec_/, ""));
  if (!keyBytes?.length) return { reason: "malformed_secret", valid: false };

  const expected = await hmacBase64(keyBytes, `${headers.id}.${headers.timestamp}.${rawBody}`);
  // The header lists space-delimited `version,signature` pairs so a secret can
  // be rotated without downtime — during rotation both the old and the new
  // signature are present, and accepting either is the point.
  const supplied = headers.signature
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => entry.slice(3));
  if (!supplied.length) return { reason: "signature_mismatch", valid: false };

  // Every candidate is compared even after a match, so the time taken does not
  // reveal which position matched.
  let matched = false;
  for (const candidate of supplied) {
    if (constantTimeEquals(expected, candidate)) matched = true;
  }
  return { reason: matched ? null : "signature_mismatch", valid: matched };
}

/**
 * يهرب محارف البدل قبل بنائها في نمط `like`.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * يجد صف الإشعار الذي يخصّه معرّف رسالة Resend.
 *
 * `provider_message_id` is not always a single id. A `channel: "both"`
 * notification stores `"<email-id>,<whatsapp-id>"` (dispatchNotification joins
 * them), so an exact match would silently skip exactly the notifications that
 * were sent two ways. The `like` narrows the scan, then the comma split
 * decides — a substring of a longer id must not count as a hit.
 *
 * Provider is deliberately *not* part of the filter: on a `both` row the stored
 * provider is whichever channel was sent last, which is the WhatsApp one, so
 * requiring `provider = 'resend'` would exclude those same rows again. A Resend
 * `email_id` is unique on its own.
 */
async function findNotificationIdByMessageId(emailId: string): Promise<string | null> {
  const query = await companyClient(requireRequestCompany().id)
    .from("notifications")
    .select("id, provider_message_id")
    .like("provider_message_id", `%${escapeLikePattern(emailId)}%`)
    .limit(20);
  if (query.error) throw new Error(query.error.message);
  const match = (query.data ?? []).find((row) =>
    (row.provider_message_id ?? "").split(",").some((id) => id.trim() === emailId),
  );
  return match?.id ?? null;
}

interface EventRecordInput {
  details: ResendEventDetails;
  error?: string | null;
  notificationId: string | null;
  payload: Json;
  providerEventId: string | null;
  result: string;
  signatureValid: boolean;
}

/**
 * ما آل إليه التسجيل: صفٌّ جديد، أم تصحيحٌ لصفٍّ رُفض سابقًا، أم إعادة إرسال حقيقية.
 */
export type EventRecordOutcome = "inserted" | "corrected" | "replay";

/**
 * يسجّل الحدث ويكشف إعادة الإرسال عبر التصادم مع فهرس `svix-id` الفريد.
 *
 * Svix retries with the *same* `svix-id`, so the unique index is the replay
 * detector. But a 23505 does not always mean "seen and handled": if the stored
 * row was rejected for a bad signature and this delivery verifies, the earlier
 * row is stale, not authoritative.
 *
 * That is the ordinary case during setup, which the runbook makes likely — the
 * endpoint deploys before `RESEND_WEBHOOK_SECRET` is set or while it is wrong,
 * every delivery is archived `unverified`, and the retry after the secret is
 * corrected then collides with the row its own rejection created. Reporting
 * that as a replay would leave the archive permanently claiming an event was
 * never verified and touched no notification, while the notification it in fact
 * moved says otherwise. So an unverified row is overwritten by the verified
 * delivery; only a collision between two *verified* rows is a true replay.
 */
async function recordEvent(input: EventRecordInput): Promise<EventRecordOutcome> {
  const companyId = requireRequestCompany().id;
  const db = companyClient(companyId);
  const row = {
    company_id: companyId,
    provider: "resend" as const,
    event_type: input.details.eventType,
    provider_event_id: input.providerEventId,
    provider_message_id: input.details.emailId,
    notification_id: input.notificationId,
    raw_payload: input.payload,
    signature_valid: input.signatureValid,
    // Only a verified delivery was actually processed. A rejected one is
    // recorded, not handled, and saying otherwise would hide it from any
    // "what did this endpoint fail to process?" query.
    processed: input.signatureValid,
    result: input.result,
    error: input.error ?? null,
  };

  const insert = await db.from("email_webhook_events").insert(row).select("id").single();
  if (!insert.error) return "inserted";
  if (insert.error.code !== "23505") throw new Error(insert.error.message);

  // Overwrite only a previously-unverified row, and only from a verified
  // delivery. The `.eq("signature_valid", false)` makes that atomic: two
  // concurrent verified retries cannot both claim to have corrected it.
  // A 23505 here can only come from the partial unique index, and that index
  // does not cover null ids — so a collision without one is unreachable rather
  // than merely unlikely. Reported as a replay instead of guessed at.
  if (!input.signatureValid || !input.providerEventId) return "replay";
  const correction = await db
    .from("email_webhook_events")
    .update(row)
    .eq("provider", "resend")
    .eq("provider_event_id", input.providerEventId)
    .eq("signature_valid", false)
    .select("id")
    .maybeSingle();
  if (correction.error) throw new Error(correction.error.message);
  return correction.data ? "corrected" : "replay";
}

/**
 * يؤرشف الحدث ثم يقبله، وهو ما تفعله كل مسارات «سجّل ولا تُغيّر إشعارًا».
 *
 * Every one of those paths answers 2xx even when it changed nothing: Resend
 * disables an endpoint that keeps failing, and a disabled endpoint would take
 * bounce reporting down with it.
 */
async function archiveAndAcknowledge(
  input: EventRecordInput,
  outcome: Record<string, boolean>,
): Promise<Response> {
  const recorded = await recordEvent(input);
  return Response.json({ ok: true, ...outcome, replay: recorded === "replay" });
}

type BodyRead = { body: string; tooLarge: false } | { bytes: number; tooLarge: true };

/**
 * يقرأ جسم الطلب مع فرض الحدّ أثناء القراءة، لا بعدها.
 *
 * Checking the size after `request.text()` bounds what gets *stored* but not
 * what gets *allocated* — the whole body is already in memory by then, and this
 * endpoint is unauthenticated until the signature is checked, so the body is
 * attacker-controlled at that moment. The declared `Content-Length` is refused
 * before a single byte is read, and a body that arrives chunked (or lies about
 * its length) is cut off mid-stream once the running total passes the cap.
 *
 * Bytes are counted from the stream rather than from the decoded string:
 * `String.length` counts UTF-16 units, and Arabic — the language most of this
 * product's mail is written in — is two UTF-8 bytes per unit, so a length check
 * would admit roughly twice the intended ceiling.
 */
async function readBodyWithinLimit(request: Request): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { bytes: declared, tooLarge: true };
  }

  const stream = request.body;
  if (!stream) {
    // No stream to meter (some runtimes and most test doubles): fall back to
    // buffering, still refusing anything over the cap before it is stored.
    const body = await request.text();
    const bytes = new TextEncoder().encode(body).length;
    return bytes > MAX_BODY_BYTES ? { bytes, tooLarge: true } : { body, tooLarge: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { bytes: total, tooLarge: true };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // The signature is computed over these exact bytes, so decoding must not
  // normalise anything — `TextDecoder` defaults to UTF-8 without BOM stripping.
  return { body: new TextDecoder().decode(merged), tooLarge: false };
}

function parsedPayload(rawBody: string): Json {
  try {
    return JSON.parse(rawBody) as Json;
  } catch {
    return { raw: rawBody };
  }
}

/**
 * يستقبل أحداث تسليم البريد من Resend ويحوّل الفشل النهائي إلى مراجعة بشرية.
 *
 * WHY `needs_review` AND NOT `failed`
 * `runNotificationDrainJob` selects rows in state `queued` or `failed` and
 * re-sends them. Writing a hard bounce as `failed` would therefore queue the
 * message straight back at an address that has already permanently rejected
 * it, up to the retry ceiling — spending the sending domain's reputation on a
 * delivery that can never succeed. `needs_review` is terminal for the drain job
 * and visible to a human, which is what a bounce actually calls for.
 *
 * `now` is injectable only so the timestamp window can be tested; production
 * always passes the real clock.
 */
export async function respondToResendWebhook(
  request: Request,
  now: number = Date.now(),
): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed, and say so. Resend disables an endpoint that keeps failing,
    // so an unconfigured secret must be loud in the logs rather than look like
    // an endpoint nobody ever called.
    console.warn("[resendWebhook] rejected a webhook because RESEND_WEBHOOK_SECRET is not set");
    return Response.json({ error: "Resend webhook secret is not configured." }, { status: 503 });
  }

  const read = await readBodyWithinLimit(request);
  if (read.tooLarge) {
    console.warn(`[resendWebhook] rejected a body of at least ${read.bytes} bytes`);
    return Response.json({ error: "Webhook payload is too large." }, { status: 413 });
  }
  const rawBody = read.body;

  const headers = svixHeaders(request);
  const payload = parsedPayload(rawBody);
  const details = resendEventDetails(payload);

  const verification = await verifySvixSignature({ headers, now, rawBody, secret });
  if (!verification.valid) {
    // The reason is logged but never the expected signature: echoing that would
    // let anyone who can read the logs have a payload of their choosing signed.
    console.warn(
      "[resendWebhook] signature rejected",
      JSON.stringify({ event: details.eventType, reason: verification.reason, id: headers.id }),
    );
    // Archived only when the delivery carries a `svix-id`. Without one the
    // partial unique index cannot dedupe, so any client on the internet could
    // POST an unsigned body in a loop and grow this table without bound. With
    // one, a repeat collapses onto the same row. The trade is deliberate: the
    // rows worth keeping are the ones that diagnose *our* secret being wrong —
    // real Resend deliveries being rejected — and those always carry the id.
    if (headers.id) {
      await recordEvent({
        details,
        error: verification.reason,
        notificationId: null,
        payload,
        providerEventId: headers.id,
        result: "unverified",
        signatureValid: false,
      });
    }
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  if (!details.terminal) {
    // Delivered, opened, clicked, delayed, transient bounces, and every
    // contact/domain/suppression event: archived, never written to a
    // notification.
    return archiveAndAcknowledge(
      {
        details,
        notificationId: null,
        payload,
        providerEventId: headers.id,
        result: details.transientBounce
          ? "transient_bounce"
          : details.eventType
            ? "ignored_event_type"
            : "unparsable_payload",
        signatureValid: true,
      },
      { ignored: true },
    );
  }

  if (!details.emailId) {
    return archiveAndAcknowledge(
      {
        details,
        error: "The event carried no data.email_id.",
        notificationId: null,
        payload,
        providerEventId: headers.id,
        result: "unmatched",
        signatureValid: true,
      },
      { unmatched: true },
    );
  }

  const notificationId = await findNotificationIdByMessageId(details.emailId);
  if (!notificationId) {
    // A terminal event whose notification row may simply not be written yet —
    // dispatchNotification stores provider_message_id only after the send
    // returns. Nothing is archived here on purpose: a stored row would collide
    // with the retry's own svix-id, and the retry is the whole point.
    // Deliberately `details.createdAtMs` and not `svix-timestamp`: Svix re-signs
    // each retry with the current clock, so every attempt would look brand new
    // and this branch would answer 503 forever — retrying until Resend disables
    // the endpoint and takes real bounce reporting down with it. An unparsable
    // `created_at` is treated as old rather than fresh, because an endless retry
    // is the worse of the two failures.
    // Bounded on both sides. A future-dated `created_at` — a skewed clock at
    // either end — would otherwise read as permanently fresh and reproduce the
    // endless retry from the other direction.
    const eventAgeMs = details.createdAtMs === null ? Infinity : now - details.createdAtMs;
    const isWithinRaceWindow =
      eventAgeMs < EARLY_MISS_WINDOW_MS && eventAgeMs > -EARLY_MISS_WINDOW_MS;
    if (isWithinRaceWindow) {
      console.warn(
        "[resendWebhook] terminal event arrived before its notification row; asking Svix to retry",
        JSON.stringify({ emailId: details.emailId, event: details.eventType, id: headers.id }),
      );
      return Response.json(
        { error: "Notification not recorded yet; retry shortly." },
        { status: 503 },
      );
    }

    // Old enough that the row would exist if it were ours: mail sent from the
    // same Resend account by something other than this app. Recorded so it
    // stays explainable, acknowledged so Resend stops retrying.
    return archiveAndAcknowledge(
      {
        details,
        notificationId: null,
        payload,
        providerEventId: headers.id,
        result: "unmatched",
        signatureValid: true,
      },
      { unmatched: true },
    );
  }

  // `.eq("state", "sent")` is the whole idempotency mechanism: a row already
  // moved to needs_review matches nothing, so a redelivery, an out-of-order
  // event and a duplicate all resolve to the same harmless no-op — and a
  // notification a human has since re-queued is never quietly overwritten.
  const update = await companyClient(requireRequestCompany().id)
    .from("notifications")
    .update({
      state: "needs_review",
      failure_reason: details.failureReason ?? "Resend reported a delivery failure.",
    })
    .eq("id", notificationId)
    .eq("state", "sent")
    .select("id")
    .maybeSingle();
  if (update.error) throw new Error(update.error.message);

  const applied = Boolean(update.data);
  return archiveAndAcknowledge(
    {
      details,
      notificationId,
      payload,
      providerEventId: headers.id,
      result: applied ? "applied" : "already_terminal",
      signatureValid: true,
    },
    { applied },
  );
}
