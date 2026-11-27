import type { SupabaseClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import {
  loadGatewayConnection,
  type LoadedGatewayConnection,
} from "@/gateways/connectionStore.server";
import { gatewayRegistry } from "@/gateways/registry";
import type { GatewayProvider } from "@/gateways/types";
import type { Database, Json } from "@/integrations/supabase/database.types";
import { enqueueJob } from "@/jobs/enqueue";
import { lookupGatewayConnectionOwner } from "@/platform/gatewayConnectionLookup.server";

const uuidSchema = z.string().uuid();

/** نتيجة البحث عن اتصال البوابة: معرّف الشركة والمزوّد المسجّل عليه. */
export interface GatewayConnectionLookup {
  companyId: string;
  provider: GatewayProvider;
}

/** التبعيات القابلة للحقن في مسار الويب هوك للاختبار ولربط طبقة المنصة. */
export interface GatewayWebhookDeps {
  lookupConnection?: (connectionId: string) => Promise<GatewayConnectionLookup | null>;
  loadConnection?: (
    db: SupabaseClient<Database>,
    connectionId: string,
  ) => Promise<LoadedGatewayConnection>;
  createDb?: (companyId: string) => SupabaseClient<Database>;
  enqueueWebhookJob?: (
    db: SupabaseClient<Database>,
    webhookEventId: string,
  ) => Promise<{ jobId: string }>;
}

/**
 * البحث الافتراضي عن مالك الاتصال عبر مساعد المنصة المسموح له بعميل الخدمة.
 *
 * This route sits outside `eslint.platform-allowlist.js`; the one privileged
 * read it needs lives in `src/platform/gatewayConnectionLookup.server.ts`.
 */
async function defaultLookupConnection(
  connectionId: string,
): Promise<GatewayConnectionLookup | null> {
  return lookupGatewayConnectionOwner(connectionId);
}

/**
 * يحوّل جسم الطلب الخام إلى JSON عند صلاحيته أو يغلفه في `{ raw }` دون إسقاط البايتات.
 */
function parseRawPayload(rawBody: string): Json {
  try {
    return JSON.parse(rawBody) as Json;
  } catch {
    return { raw: rawBody };
  }
}

/**
 * ينسخ ترويسات الطلب بمفاتيح صغيرة دون طباعة أي قيمة سرية.
 */
function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/**
 * يخزّن حدث ويب هوك في جدول `webhook_events` ويعيد معرّف الصف أو `null` عند التكرار.
 */
async function insertWebhookEvent(
  db: SupabaseClient<Database>,
  input: {
    companyId: string;
    connectionId: string;
    provider: GatewayProvider;
    eventType: string | null;
    providerEventId: string;
    providerPaymentId: string | null;
    rawPayload: Json;
    signatureValid: boolean;
    result: string;
    error?: string;
    processed: boolean;
  },
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("webhook_events")
    .insert({
      company_id: input.companyId,
      connection_id: input.connectionId,
      provider: input.provider,
      gateway:
        input.provider as Database["public"]["Tables"]["webhook_events"]["Insert"]["gateway"],
      event_type: input.eventType,
      provider_event_id: input.providerEventId,
      provider_payment_id: input.providerPaymentId,
      raw_payload: input.rawPayload,
      signature_valid: input.signatureValid,
      result: input.result,
      ...(input.error ? { error: input.error } : {}),
      processed: input.processed,
    })
    .select("id")
    .single();

  if (error?.code === "23505") return null;
  if (error) {
    throw new Error(`webhook_events insert failed: ${error.message}`);
  }
  return data;
}

/**
 * يعالج طلب ويب هوك وارد لاتصال بوابة دفع محدّد: يتحقق من المزوّد والاتصال،
 * يفحص التوقيع بسر الاتصال، يخزّن الحدث، ويدرج مهمة `webhook.process` للأحداث الجديدة الصالحة.
 *
 * Unknown or mismatched connections return 404 without leaking any company detail;
 * invalid signatures are stored with `signature_valid: false` and never enqueued;
 * duplicate events return 200 and enqueue nothing (contracts/webhooks.md).
 */
export async function handleGatewayWebhook(
  request: Request,
  params: { provider: string; connectionId: string },
  deps: GatewayWebhookDeps = {},
): Promise<Response> {
  try {
    gatewayRegistry.getFactory(params.provider);
  } catch {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  if (!uuidSchema.safeParse(params.connectionId).success) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const rawBody = await request.text();
  const lookupFn = deps.lookupConnection ?? defaultLookupConnection;
  const lookup = await lookupFn(params.connectionId);
  if (!lookup || lookup.provider !== params.provider) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const db = (deps.createDb ?? ((id) => companyClient(id, { allowSuspended: true })))(
    lookup.companyId,
  );
  const loaded = await (deps.loadConnection ?? loadGatewayConnection)(db, params.connectionId);
  if (loaded.provider !== params.provider) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const webhookSecret = loaded.connection.credentials.webhookSecret?.trim();
  if (!webhookSecret) {
    return Response.json({ error: "Webhook secret is not configured." }, { status: 503 });
  }

  const gateway = gatewayRegistry.create(loaded.connection);
  const headers = collectHeaders(request.headers);
  const verification = await gateway.verifyWebhook({
    rawBody,
    headers,
    url: request.url,
    secret: webhookSecret,
  });

  const details = await gateway.parseWebhook({ rawBody });
  const rawPayload = parseRawPayload(rawBody);

  if (!verification.valid) {
    await insertWebhookEvent(db, {
      companyId: lookup.companyId,
      connectionId: params.connectionId,
      provider: loaded.provider,
      eventType: details.eventType,
      providerEventId: details.providerEventId,
      providerPaymentId: details.paymentId,
      rawPayload,
      signatureValid: false,
      result: "invalid_signature",
      error: "Signature verification failed.",
      processed: true,
    });
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  const inserted = await insertWebhookEvent(db, {
    companyId: lookup.companyId,
    connectionId: params.connectionId,
    provider: loaded.provider,
    eventType: details.eventType,
    providerEventId: details.providerEventId,
    providerPaymentId: details.paymentId,
    rawPayload,
    signatureValid: true,
    result: "queued",
    processed: false,
  });

  if (!inserted) {
    return Response.json({ ok: true, replay: true }, { status: 200 });
  }

  const enqueueFn =
    deps.enqueueWebhookJob ??
    ((client, webhookEventId) =>
      enqueueJob(
        client,
        "webhook.process",
        { webhookEventId },
        { dedupeKey: `webhook.process:${webhookEventId}` },
      ));
  await enqueueFn(db, inserted.id);

  return Response.json({ ok: true }, { status: 200 });
}

export const Route = createFileRoute("/api/public/webhooks/$provider/$connectionId")({
  server: {
    handlers: {
      POST: ({ request, params }) => handleGatewayWebhook(request, params),
    },
  },
});
