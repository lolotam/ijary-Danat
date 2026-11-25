import { useCallback, useState } from "react";
import { toast } from "sonner";

import { uploadShopMedia } from "@/fns/uploadShopMedia";
import { useI18n } from "@/i18n/provider";
import { compressImageFile } from "@/lib/imageCompression";
import { SHOP_IMAGE_FIELDS, type ShopImageKind } from "@/lib/shopImageFields";

/** يحوّل الملف إلى base64 بدون البادئة `data:` التي لا يقبلها الخادم. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface ShopImageUpload {
  mediaId: string | null;
  previewUrl: string | null;
  uploading: boolean;
  /** ارفع ملفاً اختاره المستأجر. */
  pick: (file: File | undefined) => Promise<void>;
  /** إزالة الصورة من المحل — لا تحذف الكائن من التخزين. */
  clear: () => void;
  /** اضبط الحالة من صف المتجر القادم من الخادم. */
  reset: (mediaId: string | null, previewUrl: string | null) => void;
}

/**
 * يحمل حالة صورة واحدة من صور المتجر: المعرّف والمعاينة وحالة الرفع والرفع نفسه.
 *
 * الشعار وصورة البطاقة كانا معالجين متطابقين تقريباً داخل اللوحة، يفترقان في
 * اسم الحالة ونص الإشعار فقط. الاختلاف الوحيد الحقيقي بينهما هو `kind`.
 *
 * `reset` exists because the brand row arrives after the first render: the
 * panel seeds both images from the query result once it lands, and that is a
 * different operation from the tenant clearing an image (`clear`), which must
 * survive the next re-render rather than being seeded again.
 */
export function useShopImageUpload(
  kind: ShopImageKind,
  brandId: string | undefined,
): ShopImageUpload {
  const { t } = useI18n();
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const pick = useCallback(
    async (file: File | undefined) => {
      if (!file || !brandId) return;
      setUploading(true);
      try {
        const prepared = await compressImageFile(file, 512);
        const contentBase64 = await fileToBase64(prepared);
        const uploaded = await uploadShopMedia({
          data: {
            brandId,
            kind,
            contentBase64,
            // `compressImageFile` passes a format it cannot re-encode straight
            // through, so the prepared type is the one the server must verify.
            mimeType: prepared.type || "image/webp",
          },
        });
        setMediaId(uploaded.mediaId);
        setPreviewUrl(uploaded.url);
        toast.success(t(SHOP_IMAGE_FIELDS[kind].uploadedKey));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("portal.shop.saveError"));
      } finally {
        setUploading(false);
      }
    },
    [brandId, kind, t],
  );

  const clear = useCallback(() => {
    setMediaId(null);
    setPreviewUrl(null);
  }, []);

  const reset = useCallback((nextMediaId: string | null, nextPreviewUrl: string | null) => {
    setMediaId(nextMediaId);
    setPreviewUrl(nextPreviewUrl);
  }, []);

  return { mediaId, previewUrl, uploading, pick, clear, reset };
}
