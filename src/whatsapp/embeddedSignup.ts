import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { encodeByteaHex } from "@/gateways/connectionStore.server";
import type {
  Database,
  WhatsappConnectionMethod,
  WhatsappConnectionRow,
} from "@/integrations/supabase/database.types";
import { encryptSecret, last4 } from "@/lib/secrets.server";
import {
  lookupActiveCloudConnectionByPhoneNumberId,
  type WhatsappConnectionOwner,
} from "@/platform/whatsappConnectionLookup.server";
import { META_GRAPH_API_VERSION } from "@/whatsapp/cloudApi";

/*
 * التسجيل المدمج لواتساب (Meta Embedded Signup & Coexistence) وحفظ بيانات Cloud API اليدوية:
 * يوفّر إعدادات حزمة Meta للواجهة، ويستبدل رمز OAuth برمز وصول تجاري، ويسجّل رقم الهاتف
 * ويشترك في حساب الأعمال، ثم يخزّن الرمز مشفّراً في `company_secrets` ويفعّل الاتصال.
 */

/** قيمة `featureType` المعتمدة في توثيق Meta لتدفق التعايش مع تطبيق WhatsApp Business. */
export const COEXISTENCE_FEATURE_TYPE = "whatsapp_business_app_onboarding";

const EMBEDDED_SIGNUP_SESSION_INFO_VERSION = "3";
const PHONE_NUMBER_IN_USE_CONSTRAINT = "whatsapp_connections_active_phone_number_id_uidx";

/** رموز الأخطاء القياسية لتدفق التسجيل المدمج وحفظ بيانات Cloud API. */
export type EmbeddedSignupErrorCode =
  | "META_CONFIG_MISSING"
  | "NUMBER_IN_USE"
  | "NUMBER_NOT_IN_WABA"
  | "META_GRAPH_ERROR";

/**
 * خطأ موحّد لأعطال التسجيل المدمج: نقص إعدادات Meta، تعارض رقم هاتف نشط، أو رفض Graph API.
 */
export class EmbeddedSignupError extends Error {
  readonly code: EmbeddedSignupErrorCode;

  /** ينشئ خطأ تسجيل مدمج برمز قياسي ورسالة واضحة. */
  constructor(code: EmbeddedSignupErrorCode, message: string) {
    super(message);
    this.name = "EmbeddedSignupError";
    this.code = code;
  }
}

/** الإعدادات العامة التي يحتاجها متصفح المستخدم لإطلاق Meta Embedded Signup دون أي أسرار. */
export interface EmbeddedSignupPublicConfig {
  appId: string;
  configId: string;
  graphApiVersion: string;
  extras: {
    featureType?: string;
    sessionInfoVersion: string;
  };
}

/** مدخلات إتمام التسجيل المدمج بعد عودة الرمز ومعرّفات Meta من المتصفح. */
export interface CompleteEmbeddedSignupInput {
  companyId: string;
  code: string;
  phoneNumberId: string;
  wabaId: string;
  coexistence?: boolean;
}

/** مدخلات حفظ بيانات اعتماد WhatsApp Cloud API يدوياً. */
export interface SaveCloudCredentialsInput {
  companyId: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
}

/** تبعيات قابلة للحقن للاختبار (قاعدة البيانات، فحص ملكية الرقم، والساعة). */
export interface EmbeddedSignupDeps {
  db?: SupabaseClient<Database>;
  lookupConnection?: (phoneNumberId: string) => Promise<WhatsappConnectionOwner | null>;
  now?: () => Date;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
});

const wabaPhoneNumbersSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

const graphErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.number().optional(),
  }),
});

/**
 * يقرأ معرّف تطبيق Meta ومعرّف تهيئة التسجيل المدمج من بيئة الخادم.
 */
function readPublicMetaEnv(): { appId: string; configId: string } {
  const appId = process.env.META_APP_ID?.trim();
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim();
  if (!appId || !configId) {
    throw new EmbeddedSignupError(
      "META_CONFIG_MISSING",
      "META_APP_ID and META_EMBEDDED_SIGNUP_CONFIG_ID must be configured on the server.",
    );
  }
  return { appId, configId };
}

/**
 * يقرأ معرّف وسر تطبيق Meta من بيئة الخادم لاستبدال رمز OAuth.
 */
function readServerMetaCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new EmbeddedSignupError(
      "META_CONFIG_MISSING",
      "META_APP_ID and META_APP_SECRET must be configured on the server.",
    );
  }
  return { appId, appSecret };
}

/**
 * يعيد الإعدادات العامة اللازمة لتشغيل حزمة Facebook SDK في المتصفح دون كشف سر التطبيق.
 */
export function getEmbeddedSignupConfig(input: {
  coexistence: boolean;
}): EmbeddedSignupPublicConfig {
  const { appId, configId } = readPublicMetaEnv();
  return {
    appId,
    configId,
    graphApiVersion: META_GRAPH_API_VERSION,
    extras: input.coexistence
      ? {
          featureType: COEXISTENCE_FEATURE_TYPE,
          sessionInfoVersion: EMBEDDED_SIGNUP_SESSION_INFO_VERSION,
        }
      : {
          sessionInfoVersion: EMBEDDED_SIGNUP_SESSION_INFO_VERSION,
        },
  };
}

/**
 * يستخرج رسالة خطأ Meta Graph API من جسم الاستجابة ويرمي خطأ `META_GRAPH_ERROR`.
 */
function throwGraphError(action: string, status: number, rawBody: string): never {
  try {
    const parsed = graphErrorSchema.parse(JSON.parse(rawBody));
    const code = parsed.error.code === undefined ? "" : ` [code ${parsed.error.code}]`;
    throw new EmbeddedSignupError(
      "META_GRAPH_ERROR",
      `Meta Graph API ${action} failed (${status})${code}: ${parsed.error.message}`,
    );
  } catch (err) {
    if (err instanceof EmbeddedSignupError) throw err;
    throw new EmbeddedSignupError(
      "META_GRAPH_ERROR",
      `Meta Graph API ${action} failed (${status}): ${rawBody || "empty response"}`,
    );
  }
}

/**
 * ينفّذ طلب Graph API ويتحقق من نجاح الاستجابة ويعيد النص المحلّل.
 */
async function callGraphJson(action: string, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const rawBody = await response.text();
  if (!response.ok) {
    throwGraphError(action, response.status, rawBody);
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new EmbeddedSignupError(
      "META_GRAPH_ERROR",
      `Meta Graph API ${action} returned invalid JSON.`,
    );
  }
}

/**
 * يستبدل رمز التفويض المؤقت من Embedded Signup برمز وصول تجاري من Meta.
 */
async function exchangeCodeForBusinessToken(code: string): Promise<string> {
  const { appId, appSecret } = readServerMetaCredentials();
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    code,
  });
  const payload = await callGraphJson(
    "oauth/access_token",
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token?${params.toString()}`,
    { method: "GET" },
  );
  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new EmbeddedSignupError(
      "META_GRAPH_ERROR",
      "Meta oauth/access_token response did not include an access_token.",
    );
  }
  return parsed.data.access_token;
}

/**
 * يسجّل رقم الهاتف على واجهة WhatsApp Cloud API باستخدام رمز الوصول التجاري.
 */
async function registerCloudPhoneNumber(phoneNumberId: string, accessToken: string): Promise<void> {
  await callGraphJson(
    "register",
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/register`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp" }),
    },
  );
}

/**
 * يشترك التطبيق في أحداث ويب هوك حساب WhatsApp Business (`/{waba-id}/subscribed_apps`).
 */
async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  await callGraphJson(
    "subscribed_apps",
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(wabaId)}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

/**
 * يتأكد عبر Graph API أن الرقم مسجّل فعلاً تحت حساب WABA وأن الرمز يملك الوصول لهذا الحساب.
 *
 * Without this, a company could save another business's `phone_number_id`
 * and squat it: the active-number unique index would then block the real
 * owner from connecting. Listing `/{waba-id}/phone_numbers` with the caller's
 * own token proves both that the token reaches the WABA and that the number
 * belongs to it.
 */
async function assertPhoneNumberInWaba(
  wabaId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const payload = await callGraphJson(
    "phone_numbers",
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100`,
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const parsed = wabaPhoneNumbersSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.data.some((row) => row.id === phoneNumberId)) {
    throw new EmbeddedSignupError(
      "NUMBER_NOT_IN_WABA",
      "NUMBER_NOT_IN_WABA: this phone number is not registered under the given WhatsApp Business account.",
    );
  }
}

/**
 * يتحقق من عدم استخدام `phone_number_id` من قِبل شركة أخرى قبل الحفظ أو التفعيل.
 */
async function assertPhoneNumberAvailable(
  companyId: string,
  phoneNumberId: string,
  lookupConnection: (phoneNumberId: string) => Promise<WhatsappConnectionOwner | null>,
): Promise<void> {
  const owner = await lookupConnection(phoneNumberId);
  if (owner && owner.company_id !== companyId) {
    throw new EmbeddedSignupError(
      "NUMBER_IN_USE",
      "NUMBER_IN_USE: this WhatsApp phone number is already connected to another company.",
    );
  }
}

/**
 * يحوّل خطأ قاعدة البيانات الناتج عن قيد تفرد `phone_number_id` النشط إلى `NUMBER_IN_USE`.
 */
function mapConnectionWriteError(action: string, message: string): Error {
  if (message.includes(PHONE_NUMBER_IN_USE_CONSTRAINT)) {
    return new EmbeddedSignupError(
      "NUMBER_IN_USE",
      "NUMBER_IN_USE: this WhatsApp phone number is already connected to another company.",
    );
  }
  return new Error(`Failed to ${action} WhatsApp Cloud connection: ${message}`);
}

/**
 * يخزّن رمز الوصول مشفّراً في `company_secrets` برقم إصدار متزايد مع حفظ `last4` فقط.
 */
async function storeCloudAccessToken(
  db: SupabaseClient<Database>,
  companyId: string,
  connectionId: string,
  accessToken: string,
): Promise<void> {
  const { data: latest, error: readError } = await db
    .from("company_secrets")
    .select("version")
    .eq("owner_kind", "whatsapp")
    .eq("owner_id", connectionId)
    .eq("name", "access_token")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (readError) {
    throw new Error(`Failed to read Cloud API secret version: ${readError.message}`);
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  const encrypted = encryptSecret(accessToken);

  const { error: insertError } = await db.from("company_secrets").insert({
    company_id: companyId,
    owner_kind: "whatsapp",
    owner_id: connectionId,
    name: "access_token",
    ciphertext: encodeByteaHex(encrypted.ciphertext),
    iv: encodeByteaHex(encrypted.iv),
    auth_tag: encodeByteaHex(encrypted.authTag),
    key_version: encrypted.keyVersion,
    last4: last4(accessToken),
    version: nextVersion,
  });

  if (insertError) {
    throw new Error(`Failed to store Cloud API access_token: ${insertError.message}`);
  }
}

/**
 * ينشئ أو يحدّث صف اتصال واتساب السحابي للشركة ويجعله الطريقة النشطة الوحيدة.
 */
async function upsertAndActivateCloudConnection(
  db: SupabaseClient<Database>,
  params: {
    companyId: string;
    method: Extract<WhatsappConnectionMethod, "cloud_api" | "cloud_coexistence">;
    phoneNumberId: string;
    wabaId: string;
    accessToken: string;
    now: Date;
  },
): Promise<WhatsappConnectionRow> {
  const { data: existing, error: findError } = await db
    .from("whatsapp_connections")
    .select("*")
    .eq("company_id", params.companyId)
    .eq("method", params.method)
    .maybeSingle();

  if (findError) {
    throw new Error(`Failed to read WhatsApp connection: ${findError.message}`);
  }

  const connectedAt = params.now.toISOString();
  let connection: WhatsappConnectionRow;

  if (existing) {
    const { data: updated, error: updateError } = await db
      .from("whatsapp_connections")
      .update({
        phone_number_id: params.phoneNumberId,
        waba_id: params.wabaId,
        status: "connected",
        connected_at: connectedAt,
        last_error: null,
      })
      .eq("id", existing.id)
      .select("*")
      .single();

    if (updateError) {
      throw mapConnectionWriteError("update", updateError.message);
    }
    connection = updated;
  } else {
    const { data: inserted, error: insertError } = await db
      .from("whatsapp_connections")
      .insert({
        company_id: params.companyId,
        method: params.method,
        phone_number_id: params.phoneNumberId,
        waba_id: params.wabaId,
        status: "connected",
        is_active: false,
        connected_at: connectedAt,
        last_error: null,
      })
      .select("*")
      .single();

    if (insertError) {
      throw mapConnectionWriteError("create", insertError.message);
    }
    connection = inserted;
  }

  await storeCloudAccessToken(db, params.companyId, connection.id, params.accessToken);
  return switchActiveConnection(db, params.companyId, connection.id);
}

/**
 * يجعل اتصال واتساب المحدد هو الطريقة النشطة الوحيدة للشركة.
 *
 * Runs only after the row and its encrypted token are saved, so a failed
 * save never leaves the company with its previous method switched off and
 * nothing in its place. A number another company activated in the meantime
 * surfaces here, through the active `phone_number_id` unique index.
 */
async function switchActiveConnection(
  db: SupabaseClient<Database>,
  companyId: string,
  connectionId: string,
): Promise<WhatsappConnectionRow> {
  const { error: deactivateError } = await db
    .from("whatsapp_connections")
    .update({ is_active: false })
    .eq("company_id", companyId)
    .eq("is_active", true)
    .neq("id", connectionId);
  if (deactivateError) {
    throw new Error(`Failed to deactivate previous WhatsApp method: ${deactivateError.message}`);
  }

  const { data: activated, error: activateError } = await db
    .from("whatsapp_connections")
    .update({ is_active: true })
    .eq("id", connectionId)
    .select("*")
    .single();
  if (activateError) throw mapConnectionWriteError("activate", activateError.message);
  return activated;
}

/**
 * يتمم ربط واتساب عبر Meta Embedded Signup: يستبدل الرمز، يسجّل الرقم، يشترك في WABA،
 * يخزّن الرمز مشفّراً، ويفعّل الاتصال للشركة.
 */
export async function completeEmbeddedSignup(
  input: CompleteEmbeddedSignupInput,
  deps: EmbeddedSignupDeps = {},
): Promise<WhatsappConnectionRow> {
  const db = deps.db ?? companyClient(input.companyId);
  const lookupConnection = deps.lookupConnection ?? lookupActiveCloudConnectionByPhoneNumberId;
  const now = (deps.now ?? (() => new Date()))();

  await assertPhoneNumberAvailable(input.companyId, input.phoneNumberId, lookupConnection);

  const accessToken = await exchangeCodeForBusinessToken(input.code);
  await assertPhoneNumberInWaba(input.wabaId, input.phoneNumberId, accessToken);
  // Coexistence numbers stay registered to the WhatsApp Business app; Meta's
  // coexistence onboarding subscribes the app without `/register`. VERIFY
  // against the owner's Meta app in T164.
  if (!input.coexistence) await registerCloudPhoneNumber(input.phoneNumberId, accessToken);
  await subscribeAppToWaba(input.wabaId, accessToken);

  return upsertAndActivateCloudConnection(db, {
    companyId: input.companyId,
    method: input.coexistence ? "cloud_coexistence" : "cloud_api",
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    accessToken,
    now,
  });
}

/**
 * يحفظ بيانات اعتماد WhatsApp Cloud API المُدخلة يدوياً بعد تشفير الرمز وتفعيل الاتصال.
 */
export async function saveCloudCredentials(
  input: SaveCloudCredentialsInput,
  deps: EmbeddedSignupDeps = {},
): Promise<WhatsappConnectionRow> {
  const db = deps.db ?? companyClient(input.companyId);
  const lookupConnection = deps.lookupConnection ?? lookupActiveCloudConnectionByPhoneNumberId;
  const now = (deps.now ?? (() => new Date()))();

  await assertPhoneNumberAvailable(input.companyId, input.phoneNumberId, lookupConnection);
  await assertPhoneNumberInWaba(input.wabaId, input.phoneNumberId, input.accessToken);

  return upsertAndActivateCloudConnection(db, {
    companyId: input.companyId,
    method: "cloud_api",
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    accessToken: input.accessToken,
    now,
  });
}
