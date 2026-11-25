import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  createBackupArchive,
  deleteBackupRecord,
  listBackupRecords,
  BACKUP_BUCKET,
} from "@/fns/backupCore";
import { requirePermission } from "@/fns/requirePermission";

export const createBackupSchema = z.object({
  note: z.string().trim().optional(),
});

export const deleteBackupSchema = z.object({
  id: z.string().uuid(),
});

export const downloadBackupSchema = z.object({
  id: z.string().uuid(),
});

/**
 * ينشئ نسخة احتياطية يدوية جديدة للمستخدم.
 *
 * Admin only. Uses the core backup engine to create a manual backup.
 */
export const createBackup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(createBackupSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "settings.backup",
      attempted: "backup.create",
      refusal: "Forbidden: you do not have permission to create backups.",
    });

    const record = await createBackupArchive({
      kind: "manual",
      createdBy: context.userId,
      note: data.note,
    });

    return { ok: true, record };
  });

/**
 * يسترجع قائمة بالنسخ الاحتياطية المتاحة.
 *
 * Admin only. Returns all backup records.
 */
export const listBackups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context, {
      code: "settings.backup",
      attempted: "backup.list",
      refusal: "Forbidden: you do not have permission to list backups.",
    });

    const records = await listBackupRecords();
    return { ok: true, records };
  });

/**
 * يستخرج رابطاً مؤقتاً لتنزيل النسخة الاحتياطية.
 *
 * Admin only. Returns a 60-second signed URL for the backup zip.
 */
export const downloadBackupUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(downloadBackupSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "settings.backup",
      attempted: "backup.download",
      refusal: "Forbidden: you do not have permission to download backups.",
    });

    const { data: backup, error: fetchError } = await supabaseAdmin
      .from("backups")
      .select("storage_path")
      .eq("id", data.id)
      .single();

    if (fetchError || !backup) {
      throw new Error("Backup not found");
    }

    const { data: urlData, error: urlError } = await supabaseAdmin.storage
      .from(BACKUP_BUCKET)
      .createSignedUrl(backup.storage_path, 60);

    if (urlError) {
      throw new Error(`Could not create signed url: ${urlError.message}`);
    }

    const { error: auditError } = await supabaseAdmin.rpc("write_audit", {
      p_action: "backup.download",
      p_entity_type: "backup",
      p_entity_id: data.id,
      p_before: null,
      p_after: null,
      p_result: "success",
      p_error_code: null,
    });

    if (auditError) {
      console.error(`FATAL: Failed to write audit log for download: ${auditError.message}`);
      throw new Error(`Failed to audit download request: ${auditError.message}`);
    }

    return { ok: true, url: urlData.signedUrl };
  });

/**
 * يحذف نسخة احتياطية بشكل نهائي.
 *
 * Admin only. Deletes the given backup using the core function.
 */
export const deleteBackup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(deleteBackupSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "settings.backup",
      attempted: "backup.delete",
      refusal: "Forbidden: you do not have permission to delete backups.",
    });

    await deleteBackupRecord(data.id);

    return { ok: true };
  });
