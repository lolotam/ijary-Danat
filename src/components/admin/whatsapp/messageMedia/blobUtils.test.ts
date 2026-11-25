import { describe, expect, test } from "vitest";

import { base64ToBlob, base64ToUint8Array } from "./blobUtils";

/**
 * يثبت أن تحويل base64 إلى Blob يحافظ على البايتات ونوع MIME،
 * وأن السلسلة الفارغة لا تكسر المنطق.
 */
describe("base64ToUint8Array", () => {
  test("يحوّل hello إلى بايتات صحيحة", () => {
    // "hello" -> aGVsbG8=
    const bytes = base64ToUint8Array("aGVsbG8=");
    expect(bytes).toEqual(Uint8Array.from([104, 101, 108, 108, 111]));
  });

  test("سلسلة فارغة تعود مصفوفة فارغة", () => {
    expect(base64ToUint8Array("")).toEqual(new Uint8Array(0));
  });
});

describe("base64ToBlob", () => {
  test("ينشئ Blob بالحجم والنوع الصحيحين", () => {
    const blob = base64ToBlob("aGVsbG8=", "text/plain");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain");
    expect(blob.size).toBe(5);
  });

  test("بدون نوع MIME يستخدم application/octet-stream", () => {
    const blob = base64ToBlob("aGVsbG8=", "");
    expect(blob.type).toBe("application/octet-stream");
  });

  test("ملف صغير PDF وهمي يحافظ على الحجم", () => {
    // بايتات %PDF- -> JVBERi0x
    const blob = base64ToBlob("JVBERi0x", "application/pdf");
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe("object URL lifecycle (pure URL mock)", () => {
  test("URL.createObjectURL و revokeObjectURL يُستدعيان بشكل متوازن", () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;

    // Polyfill بسيط في بيئة node
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (blob: Blob) => {
      const url = `blob:mock/${blob.size}/${blob.type}`;
      created.push(url);
      return url;
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (
      url: string,
    ) => {
      revoked.push(url);
    };

    const blob = base64ToBlob("aGVsbG8=", "text/plain");
    const url = URL.createObjectURL(blob);
    expect(created).toContain(url);
    URL.revokeObjectURL(url);
    expect(revoked).toContain(url);

    // استعادة
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    expect(created.length).toBe(1);
    expect(revoked.length).toBe(1);
    expect(created[0]).toBe(revoked[0]);
  });
});
