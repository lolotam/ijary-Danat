import { createServerFn } from "@tanstack/react-start";

import { companyClient } from "@/company/companyClient.server";
import { CompanyContextError } from "@/company/errors";
import { getRequestCompany } from "@/company/requestCompany.server";
import { companyStoragePath } from "@/company/storagePath";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseServerInput } from "@/lib/parseServerInput";
import {
  ALLOWED_SHOP_IMAGE_TYPES,
  MAX_SHOP_IMAGE_BASE64_LENGTH,
  MAX_SHOP_IMAGE_BYTES,
  bytesMatchImageType,
  uploadShopMediaSchema,
} from "@/lib/shopMediaUpload";

/**
 * يرفع شعار المتجر أو صورة بطاقته نيابةً عن المستأجر.
 *
 * Tenants cannot write to the `landing` bucket: its only write policy is
 * `landing_admin_write` = `has_role(admin)`, stricter even than the landing
 * tables, and `landing_media` is `is_staff` write-only. Path-derived storage
 * policies would put string parsing on the security boundary, so tenants never
 * touch the bucket at all — they call this, and the service-role client writes
 * on their behalf once ownership has been proven.
 *
 * Ownership is decided by `_shop_brand_owned_by_tenant` (migration 176), the
 * SAME function `save_shop_details_as_tenant` uses. It is one authorisation
 * rule and it lives in one place; a second copy in TypeScript would be a second
 * thing to remember to change.
 *
 * "Remove image" elsewhere clears the shop's FK and does NOT delete the storage
 * object — media rows can be shared, and a hard delete would break another
 * shop's image.
 */
export const uploadShopMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseServerInput(uploadShopMediaSchema, data))
  .handler(async ({ data, context }) => {
    const profile = await context.supabase
      .from("profiles")
      .select("company_id, tenant_id")
      .eq("id", context.userId)
      .maybeSingle();
    if (profile.error) throw new Error(profile.error.message);
    const companyId = getRequestCompany()?.id ?? profile.data?.company_id;
    if (!companyId) throw new CompanyContextError("COMPANY_REQUIRED");
    const tenantId = profile.data?.tenant_id;
    if (!tenantId) throw new Error("Permission denied");

    const client = companyClient(companyId);

    const owned = await client.rpc("_shop_brand_owned_by_tenant", {
      p_brand_id: data.brandId,
      p_tenant_id: tenantId,
    });
    if (owned.error) throw new Error(owned.error.message);
    if (owned.data !== true) throw new Error("Permission denied");

    const buffer = Buffer.from(data.contentBase64, "base64");
    // `Buffer.from` never throws on malformed base64 — it silently drops the
    // invalid characters — so an empty result is how a bad payload presents.
    if (!buffer.length) throw new Error("Invalid file content");
    if (buffer.length > MAX_SHOP_IMAGE_BYTES) throw new Error("File too large");
    if (!bytesMatchImageType(buffer, data.mimeType)) {
      throw new Error("File content does not match its declared type");
    }

    const extension = ALLOWED_SHOP_IMAGE_TYPES[data.mimeType];
    const folder = data.kind === "logo" ? "shops/logos" : "shops/cards";
    const path = companyStoragePath(
      companyId,
      `${folder}/${tenantId}/${data.brandId}/${crypto.randomUUID()}.${extension}`,
    );

    const upload = await client.storage.from("landing").upload(path, buffer, {
      contentType: data.mimeType,
      upsert: false,
      cacheControl: "3600",
    });
    if (upload.error) throw new Error(upload.error.message);

    const publicUrl = client.storage.from("landing").getPublicUrl(path).data.publicUrl;

    const media = await client
      .from("landing_media")
      .insert({
        company_id: companyId,
        storage_path: publicUrl,
        mime_type: data.mimeType,
        category: data.kind === "logo" ? "logo" : "shops",
        alt_ar: "",
        alt_en: "",
        show_in_gallery: false,
        is_active: true,
        display_order: 0,
      })
      .select("id, storage_path")
      .single();
    if (media.error) {
      // The object is already in a public bucket, and nothing references it —
      // leaving it would be a file the operator can neither see nor remove.
      await client.storage.from("landing").remove([path]);
      throw new Error(media.error.message);
    }

    return { mediaId: media.data.id, url: media.data.storage_path };
  });
