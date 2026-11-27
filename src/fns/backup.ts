import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { deleteBackupRecord, listBackupRecords, BACKUP_BUCKET } from "@/fns/backupCore";
import { requirePermission } from "@/fns/requirePermission";
import { enqueueJob } from "@/jobs/enqueue";

export const deleteBackupSchema = z.object({
  id: z.string().uuid(),
});

export const downloadBackupSchema = z.object({
  id: z.string().uuid(),
});

/**
 * يحجز مهمة إنشاء نسخة احتياطية يدوية خارج الطلب: يتحقق، ثم يسجّل مهمة
 * `company.export` ويعيد معرّفها.
 *
 * Admin only. The archive is created by the worker (contracts/jobs.md section
 * 1): the request validates the permission and hands one `company.export` job
 * over, and the notice reports how it ended. Each request mints its own
 * `requestId`, the dedupe key is `company.export:<requestId>`, and the handler
 * keys the backup it creates to the job's own id — so a retried job creates
 * one backup while two deliberate clicks still get two.
 *
 * The catalogue's `company.export` payload carries ids only ("every other kind
 * carries ids only", contracts/jobs.md section 1), so the note the dialog used
 * to accept cannot travel to the worker and the input is gone rather than
 * silently dropped. Re-adding it needs one optional payload field in
 * `src/jobs/catalog.ts`.
 */
export const createBackup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context, {
      code: "settings.backup",
      attempted: "backup.create",
      refusal: "Forbidden: you do not have permission to create backups.",
    });

    const db = companyClient(requireRequestCompany().id);

    const requestId = crypto.randomUUID();
    const { jobId } = await enqueueJob(
      db,
      "company.export",
      { requestId },
      { dedupeKey: `company.export:${requestId}`, requestedBy: context.userId },
    );

    return { queued: true, jobRequestId: jobId };
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

    const db = companyClient(requireRequestCompany().id);

    const { data: backup, error: fetchError } = await db
      .from("backups")
      .select("storage_path")
      .eq("id", data.id)
      .single();

    if (fetchError || !backup) {
      throw new Error("Backup not found");
    }

    const { data: urlData, error: urlError } = await db.storage
      .from(BACKUP_BUCKET)
      .createSignedUrl(backup.storage_path, 60);

    if (urlError) {
      throw new Error(`Could not create signed url: ${urlError.message}`);
    }

    const { error: auditError } = await db.rpc("write_audit", {
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
