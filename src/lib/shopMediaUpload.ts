import { z } from "zod";

/**
 * أنواع الصور المسموح برفعها من بوابة المستأجر، ولاحقة الملف لكل نوع.
 *
 * The `landing` bucket is PUBLICLY readable (`landing_public_read`, SELECT to
 * `public`), so whatever content type is stored is the content type the browser
 * is handed. Accepting the caller's declared type would let a tenant store
 * `text/html` and have it served as HTML from our own storage origin — stored
 * XSS, from the one endpoint whose whole purpose is letting an untrusted party
 * put bytes in a public bucket.
 *
 * The extension is derived from THIS map rather than from the uploaded
 * filename, which the caller also controls: the name and the content type must
 * never be able to disagree.
 */
export const ALLOWED_SHOP_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export type ShopImageMimeType = keyof typeof ALLOWED_SHOP_IMAGE_TYPES;

/** أقصى حجم للصورة بعد فك الترميز. */
export const MAX_SHOP_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Base64 carries 3 bytes in every 4 characters, so the encoded form of the
 * limit above is ~4/3 of it. The bound belongs on the INPUT string too: without
 * it an arbitrarily large payload is accepted and buffered in full before the
 * decoded-size check ever runs.
 */
export const MAX_SHOP_IMAGE_BASE64_LENGTH = Math.ceil((MAX_SHOP_IMAGE_BYTES * 4) / 3) + 1024;

/**
 * هل تطابق البايتات الأولى النوع المُعلن؟
 *
 * A declared content type is a claim; the magic number is the fact. Checking it
 * is what stops an HTML file from being uploaded as `image/png` and then served
 * back under a content type the bucket will happily honour.
 *
 * WEBP is the awkward one: its signature is split, `RIFF` at offset 0 and
 * `WEBP` at offset 8, with the file length in between.
 */
export function bytesMatchImageType(bytes: Uint8Array, mimeType: ShopImageMimeType): boolean {
  const startsWith = (...signature: number[]) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

  switch (mimeType) {
    case "image/png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    case "image/gif":
      // GIF87a and GIF89a share the first four bytes.
      return startsWith(0x47, 0x49, 0x46, 0x38);
    case "image/webp":
      return (
        startsWith(0x52, 0x49, 0x46, 0x46) &&
        bytes.length >= 12 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
  }
}

/**
 * قيمة `accept` لمربّع اختيار الملف — نفس القائمة التي يقبلها الخادم.
 *
 * `image/*` would let the picker offer SVG and AVIF, which the server rejects.
 * `compressImageFile` passes SVG through untouched, so the tenant would choose a
 * logo, watch it upload, and be told it was invalid — a failure invented by the
 * file chooser rather than by anything they did.
 */
export const SHOP_IMAGE_ACCEPT = Object.keys(ALLOWED_SHOP_IMAGE_TYPES).join(",");

/**
 * مخطط الرفع — يعيش هنا لا داخل دالة الخادم.
 *
 * Kept out of `src/fns/uploadShopMedia.ts` so a test can assert on the whitelist
 * without importing the server module, which eagerly constructs the Supabase
 * service-role client. The schema is the security boundary; it should be
 * testable without dragging a client into the test graph.
 */
export const uploadShopMediaSchema = z.object({
  brandId: z.string().uuid(),
  kind: z.enum(["logo", "cover"]),
  contentBase64: z.string().min(1).max(MAX_SHOP_IMAGE_BASE64_LENGTH),
  // A closed set, not a string: see `ALLOWED_SHOP_IMAGE_TYPES` for why the
  // caller's declared content type cannot be trusted on a public bucket.
  mimeType: z.enum(
    Object.keys(ALLOWED_SHOP_IMAGE_TYPES) as [string, ...string[]],
  ) as z.ZodType<ShopImageMimeType>,
});
