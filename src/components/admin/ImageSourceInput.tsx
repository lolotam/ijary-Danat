import { useRef, useState } from "react";
import { Link2, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { resolveBrowserCompanyId } from "@/company/browserCompany";
import { companyStoragePath } from "@/company/storagePath";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/i18n/provider";
import { DEFAULT_MAX_DIMENSION, compressImageFile } from "@/lib/imageCompression";
import {
  LANDING_IMAGE_UPLOAD_TIMEOUT_MS,
  landingImageSizeError,
  mapLandingImageUploadError,
  withTimeout,
} from "@/lib/landingImageUpload";

/**
 * يرفع ملفاً إلى حاوية تخزين عامة تحت مسار الشركة ويعيد رابطه العام.
 */
export async function uploadImageToBucket(
  bucket: string,
  folder: string,
  file: File,
): Promise<string> {
  const companyId = await resolveBrowserCompanyId();
  const extension =
    file.name
      .split(".")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "png";
  const path = companyStoragePath(companyId, `${folder}/${crypto.randomUUID()}.${extension}`);
  const upload = await supabase.storage
    .from(bucket)
    .upload(path, file, { upsert: true, cacheControl: "3600" });
  if (upload.error) throw upload.error;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/**
 * Dual-mode image picker: paste an external URL or upload a file straight to a
 * Supabase storage bucket. Either way `onChange` receives the final URL.
 *
 * Callers must pass `bucket` explicitly — there is no default, so property
 * photos cannot silently inherit the admin-only `landing` bucket.
 * Landing uploads require `has_role(admin)` on the storage bucket. Oversized
 * files and RLS denials are mapped to clear toasts so the spinner does not look
 * like an infinite hang.
 *
 * A failed upload leaves `value` untouched and shows a persistent inline error.
 * It must never call `onChange` — some callers (property detail) persist on every
 * change, so clearing the field there would erase the saved image the user was
 * trying to replace. The inline notice is what stops the stale URL from being
 * re-saved as an unchanged "success".
 */
export function ImageSourceInput({
  value,
  onChange,
  bucket,
  folder,
  placeholder,
  canUpload = true,
  uploadHint,
  maxDimension = DEFAULT_MAX_DIMENSION,
}: {
  value: string;
  onChange: (url: string) => void;
  bucket: string;
  folder: string;
  placeholder?: string;
  /**
   * False when the signed-in role may write the owning table but not the bucket —
   * landing tables are is_staff while the landing bucket is has_role(admin). Pasting
   * a URL stays available; only the file upload is withheld.
   */
  canUpload?: boolean;
  uploadHint?: string;
  /**
   * Longest edge kept after downscaling, in pixels. The default suits covers and
   * photos; pass a smaller bound for logos, which render at a fraction of it.
   */
  maxDimension?: number;
}) {
  const { t, locale } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const lang = locale === "ar" ? "ar" : "en";

  async function handleFile(file: File | undefined) {
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    try {
      // Downscale and re-encode before the size gate, not after. A 9 MB camera
      // PNG lands well under a megabyte as WebP, so measuring the raw file first
      // would reject uploads that were never going to be a problem once shrunk.
      // `compressImageFile` returns the original on any failure, so the gate
      // below still catches genuinely oversized files.
      const prepared = await compressImageFile(file, maxDimension);

      const sizeError = landingImageSizeError(prepared.size, lang);
      if (sizeError) {
        setUploadError(sizeError);
        toast.error(sizeError);
        return;
      }

      const url = await withTimeout(
        uploadImageToBucket(bucket, folder, prepared),
        LANDING_IMAGE_UPLOAD_TIMEOUT_MS,
        "Upload",
      );
      onChange(url);
      toast.success(t("imageSource.imageUploaded"));
    } catch (error) {
      // Surface the failure inline and leave `value` alone. Calling onChange here
      // would write through on callers that persist immediately, deleting the very
      // image the user was replacing.
      const message = mapLandingImageUploadError(error, lang);
      setUploadError(message);
      toast.error(message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Link2 className="absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="ps-8"
            value={value}
            onChange={(e) => {
              setUploadError(null);
              onChange(e.target.value);
            }}
            placeholder={placeholder ?? "https://…"}
            dir="ltr"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={uploading || !canUpload}
          title={!canUpload ? uploadHint : undefined}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">{t("imageSource.upload")}</span>
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>
      {!canUpload && uploadHint ? (
        <p className="text-xs text-muted-foreground">{uploadHint}</p>
      ) : null}
      {uploadError ? (
        <p className="text-xs text-destructive" role="alert">
          {uploadError}
        </p>
      ) : null}
      {value ? (
        <img
          src={value}
          alt=""
          className="h-16 w-auto max-w-full rounded border object-contain bg-muted/30"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
          onLoad={(e) => {
            (e.target as HTMLImageElement).style.display = "";
          }}
        />
      ) : null}
    </div>
  );
}
