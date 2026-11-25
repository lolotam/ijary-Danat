/**
 * ضغط الصور في المتصفح قبل رفعها إلى Supabase Storage.
 *
 * Production measured 841 MB in the `landing` bucket across 210 files — 176 of
 * them over 2 MB, and an 8.7 MB PNG sitting in `shops/logos`. Nothing in the
 * upload path resized or re-encoded anything, and `LANDING_IMAGE_MAX_BYTES` is
 * 50 MB, so a raw camera export passed validation with 41 MB to spare. The
 * landing page then rendered 52 of those covers eagerly.
 *
 * Compressing here rather than server-side keeps the fix in one place: every
 * admin image upload funnels through `ImageSourceInput`, and the self-hosted
 * Supabase stack has no imgproxy, so on-the-fly transformation is not available.
 */

/** الحد الأقصى الافتراضي لأطول ضلع بعد التصغير (بكسل). */
export const DEFAULT_MAX_DIMENSION = 1600;

/** جودة ترميز WebP. */
const WEBP_QUALITY = 0.82;

/**
 * صيغ لا تُضغط إطلاقاً.
 *
 * SVG is vector — rasterising it to WebP would both bloat it and destroy the
 * scaling that made it worth using. GIF may be animated, and canvas re-encoding
 * silently keeps only the first frame, which reads as a corrupted upload rather
 * than a compression trade-off.
 */
const SKIPPED_TYPES = new Set(["image/svg+xml", "image/gif"]);

/** يحدد ما إذا كان الملف مرشحاً للضغط أصلاً. */
export function shouldSkipCompression(type: string): boolean {
  return !type.startsWith("image/") || SKIPPED_TYPES.has(type);
}

/**
 * يحسب الأبعاد الجديدة بحيث لا يتجاوز أطول ضلع الحد المطلوب، مع الحفاظ على النسبة.
 *
 * Returns the input untouched when it already fits — upscaling a small logo to
 * hit the bound would add bytes without adding detail.
 */
export function fitWithinBounds(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * يستبدل امتداد اسم الملف بامتداد الصيغة الجديدة.
 *
 * `uploadImageToBucket` derives the storage object's extension from `file.name`,
 * so a re-encoded file keeping its original `.png` name would be stored — and
 * served — under a content type that does not match its bytes.
 */
export function withExtension(fileName: string, extension: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, "");
  return `${base || "image"}.${extension}`;
}

/**
 * يستنتج نوع المحتوى من امتداد المسار المخزَّن، مع png كخيار أخير.
 *
 * `landing_media.mime_type` is written at insert from a path the uploader has
 * already decided on. It used to be hardcoded per call site — `image/png` for
 * carousel and brand media, `image/jpeg` for gallery — which was already wrong
 * whenever the two disagreed, and became wrong for every compressed upload once
 * the client started re-encoding to WebP. Reading the extension keeps the row
 * honest about the object it points at.
 *
 * A URL pasted by hand can carry a query string or no extension at all, hence
 * the fallback rather than a throw: a slightly wrong content type is a far
 * better outcome here than a blocked save.
 */
export function mimeTypeFromPath(storagePath: string): string {
  const extension = storagePath.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  const byExtension: Record<string, string> = {
    webp: "image/webp",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return byExtension[extension] ?? "image/png";
}

/** يرسم الصورة بالأبعاد المطلوبة ويعيدها كـ Blob بصيغة WebP. */
async function encodeResized(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", WEBP_QUALITY);
  });
}

/**
 * يصغّر الصورة ويحوّلها إلى WebP، ويعيد الملف الأصلي إذا لم ينجح الضغط أو لم يفد.
 *
 * Never throws and never blocks an upload: a decode failure, a browser without
 * canvas, or a re-encode that came out *larger* than the source all fall back to
 * the original file. Compression is an optimisation, and an admin who cannot
 * upload a photo is a worse outcome than an oversized one.
 */
export async function compressImageFile(
  file: File,
  maxDimension: number = DEFAULT_MAX_DIMENSION,
): Promise<File> {
  if (shouldSkipCompression(file.type)) return file;
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap | null = null;
  try {
    // `imageOrientation` matters: without it Chrome and Safari disagree on
    // whether EXIF rotation is already applied, so phone photos land sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitWithinBounds(bitmap.width, bitmap.height, maxDimension);
    const blob = await encodeResized(bitmap, width, height);

    // Browsers that do not encode WebP hand back a PNG from `toBlob` without
    // reporting an error, and PNG re-encoding a photo usually grows it. The size
    // check below catches that case too, but the type check keeps the stored
    // extension honest.
    if (!blob || blob.type !== "image/webp") return file;
    if (blob.size >= file.size) return file;

    return new File([blob], withExtension(file.name, "webp"), {
      type: "image/webp",
      lastModified: file.lastModified,
    });
  } catch (error) {
    // Falling back silently would hide a browser-wide encode regression: every
    // upload would quietly revert to the multi-megabyte original with nothing
    // in the logs to say so.
    console.warn("[image-compression] falling back to the original file", error);
    return file;
  } finally {
    bitmap?.close();
  }
}
