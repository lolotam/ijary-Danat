import { describe, expect, test } from "vitest";

import {
  ALLOWED_SHOP_IMAGE_TYPES,
  MAX_SHOP_IMAGE_BASE64_LENGTH,
  MAX_SHOP_IMAGE_BYTES,
  bytesMatchImageType,
  uploadShopMediaSchema,
} from "@/lib/shopMediaUpload";

/** بايتات رأس ملف لكل نوع مسموح، لاختبار مطابقة الرقم السحري. */
const HEADERS = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
} as const;

const HTML_BYTES = [..."<!doctype html><script>alert(1)</script>"].map((c) => c.charCodeAt(0));

describe("the upload schema is the whitelist", () => {
  // The server function's own tests cannot cover this: the shared
  // `createServerFn` mock skips `.inputValidator()`, so the schema is only ever
  // exercised by asserting on it directly.
  test.each(Object.keys(ALLOWED_SHOP_IMAGE_TYPES))("accepts %s", (mimeType) => {
    const parsed = uploadShopMediaSchema.safeParse({
      brandId: "11111111-1111-4111-8111-111111111111",
      kind: "logo",
      contentBase64: "AAAA",
      mimeType,
    });
    expect(parsed.success).toBe(true);
  });

  // The bucket is publicly readable, so a stored `text/html` is served as HTML
  // from our own storage origin.
  test.each(["text/html", "image/svg+xml", "application/pdf", "text/plain"])(
    "rejects %s",
    (mimeType) => {
      const parsed = uploadShopMediaSchema.safeParse({
        brandId: "11111111-1111-4111-8111-111111111111",
        kind: "logo",
        contentBase64: "AAAA",
        mimeType,
      });
      expect(parsed.success).toBe(false);
    },
  );

  test("rejects a payload larger than the encoded size limit", () => {
    const parsed = uploadShopMediaSchema.safeParse({
      brandId: "11111111-1111-4111-8111-111111111111",
      kind: "logo",
      contentBase64: "A".repeat(MAX_SHOP_IMAGE_BASE64_LENGTH + 1),
      mimeType: "image/png",
    });
    expect(parsed.success).toBe(false);
  });

  // The encoded bound has to be at least as large as the decoded one it guards,
  // or a legitimate 5 MB image would be rejected before it could be decoded.
  test("the encoded bound is wide enough for a maximum-size image", () => {
    expect(MAX_SHOP_IMAGE_BASE64_LENGTH).toBeGreaterThan((MAX_SHOP_IMAGE_BYTES * 4) / 3);
  });
});

describe("bytesMatchImageType checks the bytes, not the claim", () => {
  test.each(Object.entries(HEADERS))("%s header matches its own type", (mimeType, header) => {
    expect(
      bytesMatchImageType(
        new Uint8Array(header),
        mimeType as keyof typeof ALLOWED_SHOP_IMAGE_TYPES,
      ),
    ).toBe(true);
  });

  // The attack this exists to stop: HTML bytes uploaded under an image type
  // that the public bucket would then serve verbatim.
  test.each(Object.keys(ALLOWED_SHOP_IMAGE_TYPES))(
    "HTML bytes are rejected when declared as %s",
    (mimeType) => {
      expect(
        bytesMatchImageType(
          new Uint8Array(HTML_BYTES),
          mimeType as keyof typeof ALLOWED_SHOP_IMAGE_TYPES,
        ),
      ).toBe(false);
    },
  );

  test("a PNG declared as JPEG is rejected", () => {
    expect(bytesMatchImageType(new Uint8Array(HEADERS["image/png"]), "image/jpeg")).toBe(false);
  });

  test("an empty or truncated header is rejected rather than read past the end", () => {
    expect(bytesMatchImageType(new Uint8Array([]), "image/png")).toBe(false);
    expect(bytesMatchImageType(new Uint8Array([0x89, 0x50]), "image/png")).toBe(false);
  });

  // WEBP's signature is split — RIFF at 0, WEBP at 8 — so a file carrying only
  // the RIFF half (a WAV, for instance) must not pass.
  test("RIFF alone is not WEBP", () => {
    const riffOnly = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(bytesMatchImageType(riffOnly, "image/webp")).toBe(false);
  });
});
