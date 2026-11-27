import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  last4,
  SecretsError,
  type EncryptedSecret,
} from "./secrets.server";

const KEY_V1 = Buffer.alloc(32, 1).toString("base64");
const KEY_V2 = Buffer.alloc(32, 2).toString("base64");

const MASTER_KEY_ENV_PATTERN = /^INTEGRATIONS_MASTER_KEY(_V\d+)?$/;

/**
 * يحذف كل متغيرات مفاتيح التشفير من بيئة الاختبار
 * حتى لا تؤثر مفاتيح حقيقية على نتيجة أي اختبار.
 */
function clearMasterKeyEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (MASTER_KEY_ENV_PATTERN.test(name)) {
      delete process.env[name];
    }
  }
}

/**
 * ينفذ الدالة ويعيد خطأ SecretsError الذي ألقته، ويفشل الاختبار إن لم ترمِ الدالة.
 */
function caughtError(fn: () => unknown): SecretsError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SecretsError) return error;
    throw new Error(`expected a SecretsError, got: ${String(error)}`, { cause: error });
  }
  throw new Error("expected the call to throw, but it returned normally");
}

/**
 * يعيد نسخة من المخزن المشفّر بعد قلب أول بايت في الحقل المطلوب —
 * أي تلاعب بالنص المشفّر أو وسم المصادقة أو المتجه الابتدائي.
 */
function tamper(
  encrypted: EncryptedSecret,
  field: "ciphertext" | "iv" | "authTag",
): EncryptedSecret {
  const copy = Buffer.from(encrypted[field]);
  copy[0] ^= 0xff;
  return { ...encrypted, [field]: copy };
}

beforeEach(() => {
  clearMasterKeyEnv();
  vi.stubEnv("INTEGRATIONS_MASTER_KEY", KEY_V1);
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearMasterKeyEnv();
});

describe("encryptSecret / decryptSecret", () => {
  it.each([
    ["an ASCII API key", "sk_live_51H8xYzAbCdEf"],
    ["Arabic text", "مفتاح-سرّي-عربي-١٢٣"],
    ["newlines and symbols", 'line1\nline2\t"quotes"\\slash'],
    ["a long value", "x".repeat(5_000)],
    ["an empty value", ""],
  ])("round-trips %s", (_label, plain) => {
    const encrypted = encryptSecret(plain);

    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it("carries key version 1 and the expected buffer sizes", () => {
    const encrypted = encryptSecret("secret-value");

    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
  });

  it("produces different ciphertext and IV for the same value on every call", () => {
    const first = encryptSecret("secret-value");
    const second = encryptSecret("secret-value");

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("rejects decryption under a different master key", () => {
    const encrypted = encryptSecret("secret-value");

    vi.stubEnv("INTEGRATIONS_MASTER_KEY", KEY_V2);

    const error = caughtError(() => decryptSecret(encrypted));
    expect(error.code).toBe("DECRYPT_FAILED");
  });

  it.each([
    ["the ciphertext", "ciphertext"],
    ["the IV", "iv"],
    ["the auth tag", "authTag"],
  ] as const)("rejects a payload whose %s was tampered with", (_label, field) => {
    const tampered = tamper(encryptSecret("secret-value"), field);

    const error = caughtError(() => decryptSecret(tampered));
    expect(error.code).toBe("DECRYPT_FAILED");
  });

  it("rejects a payload whose auth tag was truncated", () => {
    const encrypted = encryptSecret("secret-value");
    const truncated = { ...encrypted, authTag: encrypted.authTag.subarray(0, 4) };

    const error = caughtError(() => decryptSecret(truncated));
    expect(error.code).toBe("DECRYPT_FAILED");
  });

  it("encrypts new values under the newest configured key version", () => {
    vi.stubEnv("INTEGRATIONS_MASTER_KEY_V2", KEY_V2);

    expect(encryptSecret("secret-value").keyVersion).toBe(2);
  });

  it("still decrypts an old key version after rotation to a newer one", () => {
    const oldBlob = encryptSecret("secret-value");
    expect(oldBlob.keyVersion).toBe(1);

    vi.stubEnv("INTEGRATIONS_MASTER_KEY_V2", KEY_V2);

    const newBlob = encryptSecret("secret-value");
    expect(newBlob.keyVersion).toBe(2);
    expect(decryptSecret(oldBlob)).toBe("secret-value");
    expect(decryptSecret(newBlob)).toBe("secret-value");
  });

  it("rejects a payload whose key version is not configured", () => {
    vi.stubEnv("INTEGRATIONS_MASTER_KEY_V2", KEY_V2);
    const blob = encryptSecret("secret-value");
    expect(blob.keyVersion).toBe(2);

    vi.unstubAllEnvs();
    vi.stubEnv("INTEGRATIONS_MASTER_KEY", KEY_V1);

    const error = caughtError(() => decryptSecret(blob));
    expect(error.code).toBe("UNKNOWN_KEY_VERSION");
    expect(error.message).toContain("2");
  });

  it("rejects decryption when no master key is configured", () => {
    const encrypted = encryptSecret("secret-value");

    clearMasterKeyEnv();

    const error = caughtError(() => decryptSecret(encrypted));
    expect(error.code).toBe("MASTER_KEY_MISSING");
  });

  it("rejects encryption when no master key is configured", () => {
    clearMasterKeyEnv();

    const error = caughtError(() => encryptSecret("secret-value"));
    expect(error.code).toBe("MASTER_KEY_MISSING");
    expect(error.message).toContain("INTEGRATIONS_MASTER_KEY");
  });

  it.each([
    ["a 16-byte key", Buffer.alloc(16, 9).toString("base64")],
    ["a 48-byte key", Buffer.alloc(48, 9).toString("base64")],
    ["a value that is not base64", "not-base64-at-all!"],
    ["a value with whitespace only", "   "],
  ])("rejects %s as INTEGRATIONS_MASTER_KEY", (_label, value) => {
    vi.stubEnv("INTEGRATIONS_MASTER_KEY", value);

    const error = caughtError(() => encryptSecret("secret-value"));
    expect(error.code).toBe(value.trim() === "" ? "MASTER_KEY_MISSING" : "MASTER_KEY_INVALID");
  });

  it("rejects a versioned key that is not 32 base64 bytes, naming the variable", () => {
    vi.stubEnv("INTEGRATIONS_MASTER_KEY_V2", "short");

    const error = caughtError(() => encryptSecret("secret-value"));
    expect(error.code).toBe("MASTER_KEY_INVALID");
    expect(error.message).toContain("INTEGRATIONS_MASTER_KEY_V2");
  });

  it.each(["INTEGRATIONS_MASTER_KEY_V0", "INTEGRATIONS_MASTER_KEY_V1"])(
    "rejects the ambiguous variable %s",
    (name) => {
      vi.stubEnv(name, KEY_V2);

      const error = caughtError(() => encryptSecret("secret-value"));
      expect(error.code).toBe("MASTER_KEY_INVALID");
      expect(error.message).toContain(name);
    },
  );
});

describe("last4", () => {
  it.each([
    ["an empty string", "", ""],
    ["a single character", "a", ""],
    ["exactly four characters", "abcd", ""],
    ["five characters", "abcde", "bcde"],
    ["an API key", "sk_live_ab12cd34", "cd34"],
    ["Arabic text with digits", "مفتاح1234", "1234"],
  ])("keeps only the last four characters of %s", (_label, plain, expected) => {
    expect(last4(plain)).toBe(expected);
  });
});
