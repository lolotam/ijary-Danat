import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BACKUP_BUCKET } from "@/fns/backupCore";
import { readArchive } from "@/lib/backupArchive";
import { requireRole } from "@/fns/requirePermission";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedSyncJob } from "@/jobs/handlers/sync";

export const restoreBackupSchema = z.object({
  id: z.string().uuid(),
  confirm: z.literal("RESTORE"),
});

export const backupRestorePreflightSchema = z.object({
  id: z.string().uuid(),
});

/**
 * يجمع معلومات ما قبل الاستعادة لتأكيدها مع المستخدم.
 *
 * Validates the backup existence and calculates how many auth.users
 * will lose their app identities upon restoration.
 */
export const backupRestorePreflight = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(backupRestorePreflightSchema)
  .handler(async ({ data, context }) => {
    await requireRole(context, "admin", {
      attempted: "backup.restore",
      refusal: "Forbidden: Only administrators can restore backups.",
    });

    const db = companyClient(requireRequestCompany().id);

    const { data: backup, error: fetchError } = await db
      .from("backups")
      .select("storage_path, table_count, row_count, created_at, file_name, size_bytes")
      .eq("id", data.id)
      .single();

    if (fetchError || !backup) throw new Error("Backup not found");

    const { data: download, error: dlError } = await db.storage
      .from(BACKUP_BUCKET)
      .download(backup.storage_path);

    if (dlError || !download) throw new Error("Could not download backup object");

    const buffer = await download.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const { manifest, tables } = readArchive(bytes);

    // من يملك حسابًا الآن ولا يوجد له صف في الأرشيف سيفقد هويته داخل التطبيق.
    //
    // Counted over `profiles`, not over `auth.users`: `auth` is not exposed to
    // PostgREST, and `profiles.id` IS the auth user id, so a profile that exists
    // now and is absent from the archive is exactly one person who will keep
    // their password and lose their access. (An earlier draft queried a table
    // named `app_users`, which does not exist in this schema — the preflight
    // would have thrown on every call.)
    const { data: currentProfiles, error: profilesError } = await db.from("profiles").select("id");

    if (profilesError) {
      throw new Error(`Could not read current profiles: ${profilesError.message}`);
    }

    const archivedProfileIds = new Set(
      ((tables.find((t) => t.name === "profiles")?.rows ?? []) as Array<{ id?: string }>)
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string"),
    );

    const orphanLogins = (currentProfiles ?? []).filter(
      (profile) => !archivedProfileIds.has(profile.id),
    ).length;

    // هل ما زالت هذه النسخة قابلة للاستعادة مع الهيكل الحالي؟
    //
    // A restore refuses outright once the archived fingerprint stops matching,
    // which is correct and a terrible thing to discover at the moment of need:
    // this project ships migrations continuously and keeps ten archives, so an
    // admin can reach for their newest backup and be told no. Answering it here
    // lets the dialog say so *before* they commit to it.
    //
    // The RPC's own error is raised rather than folded into `restorable`.
    // Discarding it would make a transport failure indistinguishable from real
    // drift, and the dialog would then claim "the schema has changed since this
    // backup was taken" — specific, wrong and unactionable. Not knowing and
    // knowing-it-changed are different answers and deserve different words.
    const { data: currentFingerprint, error: fingerprintError } = await db.rpc(
      "backup_schema_fingerprint",
    );
    if (fingerprintError || !currentFingerprint) {
      throw new Error(
        `Could not read the current schema fingerprint, so this archive's restorability is unknown: ${
          fingerprintError?.message ?? "the function returned no value"
        }`,
      );
    }
    const restorable = manifest.schema_fingerprint === currentFingerprint;

    return {
      ok: true,
      manifest: {
        file_name: backup.file_name,
        created_at: backup.created_at,
        table_count: manifest.tables.length,
        row_count: manifest.row_count,
        size_bytes: backup.size_bytes,
      },
      orphan_logins: orphanLogins,
      restorable,
    };
  });

/**
 * يحجز مهمة استعادة نسخة احتياطية خارج الطلب: يتحقق من الصلاحية ومن النسخة،
 * ثم يسجّل مهمة `company.restore` ويعيد معرّفها.
 *
 * The restore itself runs in the worker (`performRestore` in
 * `restoreBackup.server.ts`). The request
 * keeps only what is fast and safe — the admin-role gate, a read that fails a
 * wrong id on screen instead of a minute later, and the "restore requested"
 * audit entry the trail already records — and hands one `company.restore` job
 * over (contracts/jobs.md section 1).
 *
 * The payload carries the backup's id as its single `requestId`, and the job
 * is filed with NO dedupe key: an admin may restore the same backup again on
 * purpose, so a second deliberate request must queue again (the same choice
 * `sendCompanyInfo` documents). What makes a retry safe is per-job — the
 * handler's marker, keyed to the job id — not a dedupe key.
 */
export const restoreBackup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(restoreBackupSchema)
  .handler(async ({ data, context }): Promise<QueuedSyncJob> => {
    await requireRole(context, "admin", {
      attempted: "backup.restore",
      refusal: "Forbidden: Only administrators can restore backups.",
    });

    const db = companyClient(requireRequestCompany().id);

    const { data: backup, error: fetchError } = await db
      .from("backups")
      .select("id")
      .eq("id", data.id)
      .single();
    if (fetchError || !backup) throw new Error("Backup not found");

    const { error: requestAuditError } = await db.rpc("write_audit", {
      p_action: "backup.restore.requested",
      p_entity_type: "backup",
      p_entity_id: data.id,
      p_before: null,
      p_after: null,
      p_result: "success",
      p_error_code: null,
    });
    if (requestAuditError) {
      console.error(
        `FATAL: Failed to write audit log for restore request: ${requestAuditError.message}`,
      );
      throw new Error(`Failed to audit restore request: ${requestAuditError.message}`);
    }

    const { jobId } = await enqueueJob(
      db,
      "company.restore",
      { requestId: data.id },
      { requestedBy: context.userId },
    );

    return { queued: true, jobRequestId: jobId };
  });
