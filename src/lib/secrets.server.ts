import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * تشفير أسرار الشركات: AES-256-GCM بمفاتيح رئيسية مرقّمة الإصدار.
 *
 * Per research.md R9 this is the only place a secret is encrypted or
 * decrypted, at the moment of use. Nothing here logs plaintext or key
 * material, and `INTEGRATIONS_MASTER_KEY` is server-only — it must never
 * appear in a `VITE_` variable, which is compiled into the browser bundle.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
// GCM accepts truncated auth tags unless the length is pinned, and a short tag
// is far easier to forge, so decryption only accepts the full 16 bytes.
const AUTH_TAG_LENGTH = 16;
const MASTER_KEY_ENV = "INTEGRATIONS_MASTER_KEY";
const VERSIONED_MASTER_KEY_PATTERN = /^INTEGRATIONS_MASTER_KEY_V(\d+)$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** رموز أخطاء التشفير القياسية. */
export const SECRETS_ERROR_CODES = [
  "MASTER_KEY_MISSING",
  "MASTER_KEY_INVALID",
  "UNKNOWN_KEY_VERSION",
  "DECRYPT_FAILED",
] as const;

export type SecretsErrorCode = (typeof SECRETS_ERROR_CODES)[number];

const SECRETS_ERROR_MESSAGES: Record<SecretsErrorCode, string> = {
  MASTER_KEY_MISSING: `${MASTER_KEY_ENV} is not set; integration secrets cannot be encrypted or decrypted.`,
  MASTER_KEY_INVALID: "A configured integration master key is invalid.",
  UNKNOWN_KEY_VERSION: "No master key is configured for this key version.",
  DECRYPT_FAILED: "The secret could not be decrypted (wrong master key or tampered data).",
};

/**
 * خطأ موحّد لأعطال تشفير الأسرار: غياب أو فساد المفتاح الرئيسي،
 * إصدار مفتاح غير موجود، أو فشل فك التشفير لمخزن مُتلاعب به.
 */
export class SecretsError extends Error {
  readonly code: SecretsErrorCode;

  /** ينشئ خطأ تشفير برمز قياسي ورسالة اختيارية وسبب اختياري. */
  constructor(code: SecretsErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? SECRETS_ERROR_MESSAGES[code], options);
    this.name = "SecretsError";
    this.code = code;
  }
}

/** السر كما يُخزَّن في `company_secrets`: نص مشفّر ومتجه ابتدائي ووسم مصادقة وإصدار المفتاح. */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

/** مجموعة المفاتيح الرئيسيّة المكوّنة، مع المفتاح الحالي (الأحدث إصداراً) الذي يُشفّر به. */
interface MasterKeys {
  current: { version: number; key: Buffer };
  byVersion: Map<number, Buffer>;
}

/**
 * يتحقق من أن القيمة سلسلة Base64 صالحة بطول 32 بايت (AES-256-GCM).
 *
 * Mirrors `isValidBase64Key32` in `src/lib/env.server.ts`, which is not
 * exported and validates only the startup path; this module re-checks at the
 * moment of use because `validateEnv` is skipped under Vitest.
 */
function isValidBase64Key32(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").length === 32;
}

/**
 * يفك ترميز مفتاح رئيسي من متغير بيئة ويرمِ خطأً مطبّعاً يسمّي المتغير إن كان فاسداً —
 * دون أن تظهر القيمة نفسها في الرسالة أو السجلات.
 */
function decodeMasterKey(name: string, rawValue: string): Buffer {
  const value = rawValue.trim();
  if (!isValidBase64Key32(value)) {
    throw new SecretsError(
      "MASTER_KEY_INVALID",
      `${name} must be a base64-encoded 32-byte key (openssl rand -base64 32).`,
    );
  }
  return Buffer.from(value, "base64");
}

/**
 * يجمع المفاتيح المرقّمة الإصدار من البيئة.
 *
 * R9 fixes the rotation behaviour (add a new version, keep old versions
 * readable) but names no variables, so the scheme chosen here is:
 * `INTEGRATIONS_MASTER_KEY` is version 1, and `INTEGRATIONS_MASTER_KEY_V2`
 * and up are higher versions — the highest configured version is the current
 * one that encrypts. The `_V0` / `_V1` names are rejected because version 1
 * is the unversioned variable and accepting both would leave it ambiguous
 * which key decrypts a `key_version: 1` row.
 */
function versionedMasterKeys(): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const [name, rawValue] of Object.entries(process.env)) {
    const match = VERSIONED_MASTER_KEY_PATTERN.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (version < 2) {
      throw new SecretsError(
        "MASTER_KEY_INVALID",
        `${name} is not a valid master key name; version 1 is ${MASTER_KEY_ENV} and numbered names start at ${MASTER_KEY_ENV}_V2.`,
      );
    }
    keys.set(version, decodeMasterKey(name, rawValue ?? ""));
  }
  return keys;
}

/**
 * يقرأ مفاتيح التشفير من البيئة وقت الاستخدام؛ المفتاح الحالي هو الأعلى إصداراً.
 */
function loadMasterKeys(): MasterKeys {
  const primaryValue = process.env[MASTER_KEY_ENV];
  if (!primaryValue || !primaryValue.trim()) {
    throw new SecretsError("MASTER_KEY_MISSING");
  }
  const byVersion = new Map<number, Buffer>();
  let current = { version: 1, key: decodeMasterKey(MASTER_KEY_ENV, primaryValue) };
  byVersion.set(current.version, current.key);
  for (const [version, key] of versionedMasterKeys()) {
    byVersion.set(version, key);
    if (version > current.version) current = { version, key };
  }
  return { current, byVersion };
}

/**
 * يشفّر سراً بالنص الحر تحت المفتاح الحالي، بمتجه ابتدائي عشوائي من 12 بايت في كل مرة،
 * ويعيد النص المشفّر مع وسم المصادقة وإصدار المفتاح المستخدم.
 */
export function encryptSecret(plain: string): EncryptedSecret {
  const { current } = loadMasterKeys();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, current.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion: current.version,
  };
}

/**
 * يفك تشفير مخزن أسرار بالمفتاح المطابق لإصداره، ويرمِ SecretsError
 * لإصدار مفتاح غير موجود أو خطاً مشفّراً بخطأ أو مُتلاعب به — لا يعيد بيانات فاسدة أبداً.
 */
export function decryptSecret(encrypted: EncryptedSecret): string {
  const { byVersion } = loadMasterKeys();
  const key = byVersion.get(encrypted.keyVersion);
  if (!key) {
    throw new SecretsError(
      "UNKNOWN_KEY_VERSION",
      `No master key is configured for key version ${encrypted.keyVersion}.`,
    );
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(encrypted.authTag);
    const plain = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch (cause) {
    throw new SecretsError(
      "DECRYPT_FAILED",
      `The secret could not be decrypted with key version ${encrypted.keyVersion} (wrong master key or tampered data).`,
      { cause },
    );
  }
}

/**
 * يعرض آخر أربعة أحرف من السر فقط، لأن هذا وحده ما يصل إلى الشاشات (R9).
 *
 * A secret of four characters or fewer comes back empty: a last-4 view would
 * reveal it whole, and an unrecognisable secret is safer than a leaked one.
 */
export function last4(plain: string): string {
  return plain.length > 4 ? plain.slice(-4) : "";
}
