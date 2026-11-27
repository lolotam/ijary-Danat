import type { SupabaseClient } from "@supabase/supabase-js";

import { CompanyContextError } from "@/company/errors";
import type { GatewayConnection, GatewayMode, GatewayProvider } from "@/gateways/types";
import type { Database, GatewayConnectionRow, Json } from "@/integrations/supabase/database.types";
import { decryptSecret, encryptSecret, last4 } from "@/lib/secrets.server";

/*
 * مخزن اتصالات بوابات الدفع: قراءة الاتصال النشط أو المحدّد وفك تشفير أسراره،
 * وحفظ بيانات الاعتماد المشفّرة مع تدوير رقم الإصدار عند التغيير.
 *
 * Uses `companyClient(companyId)` (`company_service` role) so RLS isolates
 * every read and write to one company without ever touching `service_role`.
 */

const BYTEA_HEX_PATTERN = /^\\x([0-9a-fA-F]{2})*$/;

/** رموز أخطاء مخزن اتصالات البوابات. */
export const GATEWAY_CONNECTION_ERROR_CODES = [
  "CONNECTION_NOT_FOUND",
  "INVALID_BYTEA_HEX",
  "LIVE_NOT_ALLOWED",
] as const;

export type GatewayConnectionErrorCode = (typeof GATEWAY_CONNECTION_ERROR_CODES)[number];

/**
 * خطأ موحّد لأعطال مخزن اتصالات البوابات: غياب الاتصال أو فساد صيغة `bytea`.
 */
export class GatewayConnectionError extends Error {
  readonly code: GatewayConnectionErrorCode;

  /** ينشئ خطأ مخزن بوابات برمز قياسي ورسالة توضيحية. */
  constructor(code: GatewayConnectionErrorCode, message: string) {
    super(message);
    this.name = "GatewayConnectionError";
    this.code = code;
  }
}

/**
 * يحوّل رفض قاعدة البيانات لحفظ اتصال بوابة إلى خطأ واضح الرمز.
 *
 * Migration 324 refuses live mode with `GATEWAY_LIVE_NOT_ALLOWED` until the
 * super admin allows the provider (SC-012); any other failure stays generic.
 */
function gatewayWriteError(action: string, message: string): Error {
  if (message.includes("GATEWAY_LIVE_NOT_ALLOWED")) {
    return new GatewayConnectionError(
      "LIVE_NOT_ALLOWED",
      "LIVE_NOT_ALLOWED: live mode is not yet allowed for this payment provider.",
    );
  }
  return new Error(`Failed to ${action} gateway connection: ${message}`);
}

/** اتصال البوابة المحمّل مع بياناته التعريفية وأسراره المفكوكة التشفير. */
export interface LoadedGatewayConnection {
  id: string;
  companyId: string;
  provider: GatewayProvider;
  mode: GatewayMode;
  isActive: boolean;
  credentialsVersion: number;
  connection: GatewayConnection;
}

/** مدخلات حفظ بيانات اعتماد بوابة دفع وإعداداتها العامة. */
export interface SaveGatewayCredentialsInput {
  provider: GatewayProvider;
  mode: GatewayMode;
  publicConfig: Json;
  credentials: Record<string, string>;
}

/**
 * يحوّل مخزناً ثنائياً إلى صيغة `bytea` السداسية عشرياً التي يقبلها PostgREST (`\x...`).
 */
export function encodeByteaHex(bytes: Buffer): string {
  return `\\x${bytes.toString("hex")}`;
}

/**
 * يفك صيغة `bytea` السداسية عشرياً العائدة من PostgREST (`\x...`) إلى `Buffer`.
 */
export function decodeByteaHex(value: string): Buffer {
  if (!BYTEA_HEX_PATTERN.test(value)) {
    throw new GatewayConnectionError(
      "INVALID_BYTEA_HEX",
      "Stored secret bytea column is not valid Postgres hex.",
    );
  }
  return Buffer.from(value.slice(2), "hex");
}

/**
 * يقرأ أسرار اتصال محدّد عند إصدار معيّن ويفك تشفيرها في خريطة باسم السر.
 */
async function loadCredentialsMap(
  db: SupabaseClient<Database>,
  connectionId: string,
  version: number,
): Promise<Record<string, string>> {
  const { data, error } = await db
    .from("company_secrets")
    .select("name, ciphertext, iv, auth_tag, key_version")
    .eq("owner_kind", "gateway")
    .eq("owner_id", connectionId)
    .eq("version", version);

  if (error) {
    throw new Error(`Failed to load gateway secrets: ${error.message}`);
  }

  const credentials: Record<string, string> = {};
  for (const row of data ?? []) {
    credentials[row.name] = decryptSecret({
      ciphertext: decodeByteaHex(row.ciphertext),
      iv: decodeByteaHex(row.iv),
      authTag: decodeByteaHex(row.auth_tag),
      keyVersion: row.key_version,
    });
  }
  return credentials;
}

/**
 * يكوّن كائن الاتصال الكامل من صف `gateway_connections` بعد فك تشفير أسرار إصداره الحالي.
 */
async function hydrateGatewayConnection(
  db: SupabaseClient<Database>,
  row: GatewayConnectionRow,
): Promise<LoadedGatewayConnection> {
  const credentials = await loadCredentialsMap(db, row.id, row.credentials_version);
  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    mode: row.mode,
    isActive: row.is_active,
    credentialsVersion: row.credentials_version,
    connection: {
      provider: row.provider,
      mode: row.mode,
      credentials,
      publicConfig: row.public_config,
    },
  };
}

/**
 * يحمّل اتصال بوابة دفع محدّداً بالمعرّف مع فك تشفير أسرار إصداره الحالي، ويرمي خطأً عند غيابه.
 */
export async function loadGatewayConnection(
  db: SupabaseClient<Database>,
  connectionId: string,
): Promise<LoadedGatewayConnection> {
  const { data, error } = await db
    .from("gateway_connections")
    .select("*")
    .eq("id", connectionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load gateway connection: ${error.message}`);
  }
  if (!data) {
    throw new GatewayConnectionError(
      "CONNECTION_NOT_FOUND",
      `Gateway connection ${connectionId} was not found.`,
    );
  }

  return hydrateGatewayConnection(db, data);
}

/**
 * يحمّل اتصال بوابة الدفع النشط للشركة الحالية مع أسراره المفكوكة، أو `null` إذا لم يوجد اتصال نشط.
 */
export async function loadActiveGatewayConnection(
  db: SupabaseClient<Database>,
): Promise<LoadedGatewayConnection | null> {
  const { data, error } = await db
    .from("gateway_connections")
    .select("*")
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load active gateway connection: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  return hydrateGatewayConnection(db, data);
}

/**
 * يقارن خريطتي أسرار لتحديد ما إذا تغيّرت بيانات الاعتماد وتستوجب رفع رقم الإصدار.
 */
function areCredentialMapsEqual(
  current: Record<string, string>,
  next: Record<string, string>,
): boolean {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) {
    return false;
  }
  return nextKeys.every((key) => Object.hasOwn(current, key) && current[key] === next[key]);
}

/**
 * يشفّر بيانات الاعتماد ويدرجها في `company_secrets` تحت رقم الإصدار المحدّد.
 */
async function insertEncryptedCredentials(
  db: SupabaseClient<Database>,
  params: {
    companyId: string;
    connectionId: string;
    version: number;
    credentials: Record<string, string>;
  },
): Promise<void> {
  const entries = Object.entries(params.credentials);
  if (entries.length === 0) return;

  const rows = entries.map(([name, plain]) => {
    const encrypted = encryptSecret(plain);
    return {
      company_id: params.companyId,
      owner_kind: "gateway" as const,
      owner_id: params.connectionId,
      name,
      ciphertext: encodeByteaHex(encrypted.ciphertext),
      iv: encodeByteaHex(encrypted.iv),
      auth_tag: encodeByteaHex(encrypted.authTag),
      key_version: encrypted.keyVersion,
      last4: last4(plain),
      version: params.version,
    };
  });

  const { error } = await db.from("company_secrets").insert(rows);
  if (error) {
    throw new Error(`Failed to save gateway secrets: ${error.message}`);
  }
}

/**
 * يقرأ معرّف الشركة الحالية من سياق `companyClient` عند إنشاء اتصال جديد.
 */
async function resolveDbCompanyId(db: SupabaseClient<Database>): Promise<string> {
  const { data, error } = await db.rpc("current_company_id");
  if (error) {
    throw new Error(`Failed to resolve company id: ${error.message}`);
  }
  if (!data) {
    throw new CompanyContextError("COMPANY_REQUIRED");
  }
  return data;
}

/**
 * يحفظ أو يحدّث اتصال بوابة الدفع وبيانات اعتماده المشفّرة؛ يرفع `credentials_version`
 * عند تغيير الأسرار فقط ليُبطل مُشغّل قاعدة البيانات الاختبار السابق والتفعيل تلقائياً.
 */
export async function saveGatewayCredentials(
  db: SupabaseClient<Database>,
  input: SaveGatewayCredentialsInput,
): Promise<GatewayConnectionRow> {
  const { data: existing, error: lookupError } = await db
    .from("gateway_connections")
    .select("*")
    .eq("provider", input.provider)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Failed to read gateway connection: ${lookupError.message}`);
  }

  if (!existing) {
    const companyId = await resolveDbCompanyId(db);
    const { data: inserted, error: insertError } = await db
      .from("gateway_connections")
      .insert({
        company_id: companyId,
        provider: input.provider,
        mode: input.mode,
        public_config: input.publicConfig,
        credentials_version: 1,
      })
      .select("*")
      .single();

    if (insertError) {
      throw gatewayWriteError("create", insertError.message);
    }

    await insertEncryptedCredentials(db, {
      companyId,
      connectionId: inserted.id,
      version: 1,
      credentials: input.credentials,
    });
    return inserted;
  }

  const hasIncomingCredentials = Object.keys(input.credentials).length > 0;
  const existingCredentials = hasIncomingCredentials
    ? await loadCredentialsMap(db, existing.id, existing.credentials_version)
    : {};
  const credentialsChanged =
    hasIncomingCredentials && !areCredentialMapsEqual(existingCredentials, input.credentials);

  const nextVersion = credentialsChanged
    ? existing.credentials_version + 1
    : existing.credentials_version;

  if (credentialsChanged) {
    // Insert the new version's secrets before bumping `credentials_version` so
    // a failed secret write never leaves the connection pointing to missing rows.
    await insertEncryptedCredentials(db, {
      companyId: existing.company_id,
      connectionId: existing.id,
      version: nextVersion,
      credentials: input.credentials,
    });
  }

  const { data: updated, error: updateError } = await db
    .from("gateway_connections")
    .update({
      mode: input.mode,
      public_config: input.publicConfig,
      ...(credentialsChanged ? { credentials_version: nextVersion } : {}),
    })
    .eq("id", existing.id)
    .select("*")
    .single();

  if (updateError) {
    throw gatewayWriteError("update", updateError.message);
  }

  return updated;
}
