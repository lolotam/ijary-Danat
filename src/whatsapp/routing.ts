import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { decodeByteaHex } from "@/gateways/connectionStore.server";
import type { Database, Json } from "@/integrations/supabase/database.types";
import { decryptSecret } from "@/lib/secrets.server";
import { lookupActiveCloudConnectionByPhoneNumberId } from "@/platform/whatsappConnectionLookup.server";

/*
 * توجيه أحداث ويب هوك Meta Cloud API: البحث عن الاتصال النشط عبر `phone_number_id`،
 * التحقق من توقيع `X-Hub-Signature-256` في زمن ثابت، وحفظ الرسائل الواردة معزولة للشركة.
 */

const SHA256_PREFIX = "sha256=";
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

/** الاتصال النشط المطابق لمعرّف رقم الهاتف لدى Meta. */
export interface ActiveMetaConnection {
  id: string;
  companyId: string;
  phoneNumberId: string;
  method: "cloud_api" | "cloud_coexistence";
}

/** التبعيات القابلة للحقن في معالج ويب هوك Meta للاختبار. */
export interface MetaWebhookDeps {
  lookupConnection?: (phoneNumberId: string) => Promise<ActiveMetaConnection | null>;
  loadAppSecret?: (companyId: string, connectionId: string) => Promise<string | null>;
  createDb?: (companyId: string) => SupabaseClient<Database>;
  logger?: Pick<Console, "warn">;
}

const metaMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string().default("text"),
  text: z.object({ body: z.string() }).optional(),
});

const metaChangeSchema = z.object({
  field: z.string().optional(),
  value: z.object({
    metadata: z
      .object({
        phone_number_id: z.string().min(1).optional(),
      })
      .optional(),
    contacts: z
      .array(
        z.object({
          wa_id: z.string().optional(),
          profile: z.object({ name: z.string().optional() }).optional(),
        }),
      )
      .optional(),
    messages: z.array(metaMessageSchema).optional(),
  }),
});

const metaWebhookPayloadSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z.array(metaChangeSchema).default([]),
      }),
    )
    .default([]),
});

type MetaChange = z.infer<typeof metaChangeSchema>;

/**
 * يبحث عن اتصال واتساب النشط المطابق لمعرّف رقم الهاتف لدى Meta، قبل معرفة الشركة.
 */
export async function findActiveConnectionByPhoneNumberId(
  phoneNumberId: string,
): Promise<ActiveMetaConnection | null> {
  const row = await lookupActiveCloudConnectionByPhoneNumberId(phoneNumberId);
  if (!row?.phone_number_id) return null;
  if (row.method !== "cloud_api" && row.method !== "cloud_coexistence") return null;
  return {
    id: row.id,
    companyId: row.company_id,
    phoneNumberId: row.phone_number_id,
    method: row.method,
  };
}

/**
 * يقرأ ويفك تشفير سرّ التطبيق (`app_secret`) لاتصال واتساب محدّد من جدول `company_secrets`.
 */
export async function loadMetaAppSecret(
  companyId: string,
  connectionId: string,
): Promise<string | null> {
  const db = companyClient(companyId, { allowSuspended: true });
  const { data, error } = await db
    .from("company_secrets")
    .select("ciphertext, iv, auth_tag, key_version")
    .eq("owner_kind", "whatsapp")
    .eq("owner_id", connectionId)
    .eq("name", "app_secret")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Meta app_secret: ${error.message}`);
  }
  if (!data) return null;

  return decryptSecret({
    ciphertext: decodeByteaHex(data.ciphertext),
    iv: decodeByteaHex(data.iv),
    authTag: decodeByteaHex(data.auth_tag),
    keyVersion: data.key_version,
  });
}

/**
 * يتحقق من توقيع `X-Hub-Signature-256` في زمن ثابت باستخدام سرّ التطبيق.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SHA256_PREFIX)) {
    return false;
  }
  const hexPart = signatureHeader.slice(SHA256_PREFIX.length);
  if (!HEX_64_PATTERN.test(hexPart)) {
    return false;
  }
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const actual = Buffer.from(hexPart, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * يحوّل الطابع الزمني بالثواني من Meta إلى صيغة ISO-8601.
 */
function toIsoTimestamp(unixSeconds?: string): string {
  const parsed = unixSeconds ? Number(unixSeconds) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return new Date(parsed * 1000).toISOString();
  }
  return new Date().toISOString();
}

/**
 * يخزّن الرسائل الواردة وتحديثات المحادثات في جداول واتساب الخاصة بالشركة والاتصال.
 */
async function persistInboundChanges(
  db: SupabaseClient<Database>,
  connection: ActiveMetaConnection,
  changes: MetaChange[],
): Promise<void> {
  const chatRows: Array<Database["public"]["Tables"]["whatsapp_chats"]["Insert"]> = [];
  const messageRows: Array<Database["public"]["Tables"]["whatsapp_messages"]["Insert"]> = [];

  for (const change of changes) {
    const contactsByWaId = new Map(
      (change.value.contacts ?? [])
        .filter((c): c is { wa_id: string; profile?: { name?: string } } => Boolean(c.wa_id))
        .map((c) => [c.wa_id, c.profile?.name ?? null]),
    );
    for (const msg of change.value.messages ?? []) {
      const sentAt = toIsoTimestamp(msg.timestamp);
      const body = msg.text?.body ?? null;
      chatRows.push({
        company_id: connection.companyId,
        connection_id: connection.id,
        chat_number: msg.from,
        display_name: contactsByWaId.get(msg.from) ?? null,
        last_message_preview: body,
        last_message_at: sentAt,
      });
      messageRows.push({
        company_id: connection.companyId,
        connection_id: connection.id,
        message_id: msg.id,
        chat_number: msg.from,
        direction: "inbound",
        from_me: false,
        body,
        message_type: msg.type,
        sent_at: sentAt,
        status: "received",
        raw: msg as unknown as Json,
      });
    }
  }

  if (chatRows.length > 0) {
    const { error: chatError } = await db
      .from("whatsapp_chats")
      .upsert(chatRows, { onConflict: "company_id,chat_number" });
    if (chatError) {
      throw new Error(`whatsapp_chats upsert failed: ${chatError.message}`);
    }
  }

  if (messageRows.length > 0) {
    const { error: msgError } = await db
      .from("whatsapp_messages")
      .upsert(messageRows, { onConflict: "company_id,message_id" });
    if (msgError) {
      throw new Error(`whatsapp_messages upsert failed: ${msgError.message}`);
    }
  }
}

/**
 * يجمع التغييرات الواردة مجمّعةً حسب `phone_number_id` لتوجيه كل مجموعة إلى اتصالها.
 */
function groupChangesByPhoneNumberId(
  payload: z.infer<typeof metaWebhookPayloadSchema>,
): Map<string, MetaChange[]> {
  const byPhoneId = new Map<string, MetaChange[]>();
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const list = byPhoneId.get(phoneNumberId) ?? [];
      list.push(change);
      byPhoneId.set(phoneNumberId, list);
    }
  }
  return byPhoneId;
}

/**
 * يعالج طلب التحقق (GET handshake) من Meta باستخدام متغير البيئة `META_WEBHOOK_VERIFY_TOKEN`.
 */
export async function handleMetaWebhookGet(request: Request): Promise<Response> {
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (!expectedToken) {
    return Response.json(
      { error: "Meta webhook verify token is not configured." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return Response.json({ error: "Webhook verification failed." }, { status: 403 });
  }

  const expectedBuf = Buffer.from(expectedToken, "utf8");
  const actualBuf = Buffer.from(token, "utf8");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return Response.json({ error: "Webhook verification failed." }, { status: 403 });
  }

  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/**
 * يعالج أحداث POST الواردة من Meta Cloud API: يوجّه الحدث عبر `phone_number_id`،
 * يتحقق من التوقيع، ويسقط الأرقام غير المعروفة مع تسجيلها وإرجاع 200.
 */
export async function handleMetaWebhookPost(
  request: Request,
  deps: MetaWebhookDeps = {},
): Promise<Response> {
  const rawBody = await request.text();
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const parsed = metaWebhookPayloadSchema.safeParse(rawJson);
  if (!parsed.success) {
    return Response.json({ error: "Malformed Meta webhook payload." }, { status: 400 });
  }

  const byPhoneId = groupChangesByPhoneNumberId(parsed.data);
  if (byPhoneId.size === 0) {
    return Response.json({ ok: true, dropped: 0, routedCompanies: [] }, { status: 200 });
  }

  const lookupFn = deps.lookupConnection ?? ((id) => findActiveConnectionByPhoneNumberId(id));
  const loadSecretFn = deps.loadAppSecret ?? loadMetaAppSecret;
  const createDbFn = deps.createDb ?? ((companyId: string) => companyClient(companyId));
  const logger = deps.logger ?? console;
  const signatureHeader = request.headers.get("x-hub-signature-256");

  const routedCompanies: string[] = [];
  let dropped = 0;

  for (const [phoneNumberId, changes] of byPhoneId) {
    const connection = await lookupFn(phoneNumberId);
    if (!connection) {
      logger.warn(`Meta webhook dropped: unknown phone_number_id=${phoneNumberId}`);
      dropped += 1;
      continue;
    }

    const appSecret = await loadSecretFn(connection.companyId, connection.id);
    if (!appSecret) {
      return Response.json({ error: "Webhook secret is not configured." }, { status: 503 });
    }

    if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) {
      return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
    }

    const db = createDbFn(connection.companyId);
    await persistInboundChanges(db, connection, changes);
    routedCompanies.push(connection.companyId);
  }

  return Response.json({ ok: true, dropped, routedCompanies }, { status: 200 });
}
