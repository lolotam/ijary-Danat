import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/database.types";
import { BACKUP_BUCKET, createBackupArchive } from "@/fns/backupCore";
import { readArchive, sha256Hex } from "@/lib/backupArchive";
import { requireRole } from "@/fns/requirePermission";

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

    const { data: backup, error: fetchError } = await supabaseAdmin
      .from("backups")
      .select("storage_path, table_count, row_count, created_at, file_name, size_bytes")
      .eq("id", data.id)
      .single();

    if (fetchError || !backup) throw new Error("Backup not found");

    const { data: download, error: dlError } = await supabaseAdmin.storage
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
    const { data: currentProfiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("id");

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
    const { data: currentFingerprint, error: fingerprintError } = await supabaseAdmin.rpc(
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
 * ينفذ عملية استعادة قاعدة البيانات من نسخة احتياطية معينة.
 *
 * Restores a backup. Verifies the SHA-256 digest, creates a safety backup,
 * calls the restore RPC, and audits the action.
 */
export const restoreBackup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(restoreBackupSchema)
  .handler(async ({ data, context }) => {
    await requireRole(context, "admin", {
      attempted: "backup.restore",
      refusal: "Forbidden: Only administrators can restore backups.",
    });

    const { error: requestAuditError } = await supabaseAdmin.rpc("write_audit", {
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

    async function auditRestoreFailure(errorMsg: string, errorCode: string) {
      const { error } = await supabaseAdmin.rpc("write_audit", {
        p_action: "backup.restore",
        p_entity_type: "backup",
        p_entity_id: data.id,
        p_before: null,
        p_after: { error: errorMsg },
        p_result: "failure",
        p_error_code: errorCode,
      });
      if (error) {
        console.error(`FATAL: Failed to write audit log for restore failure: ${error.message}`);
      }
    }

    const { data: backup, error: fetchError } = await supabaseAdmin
      .from("backups")
      .select("storage_path, sha256")
      .eq("id", data.id)
      .single();

    if (fetchError || !backup) {
      await auditRestoreFailure("Backup not found", "BACKUP_NOT_FOUND");
      throw new Error("Backup not found");
    }

    const { data: download, error: dlError } = await supabaseAdmin.storage
      .from(BACKUP_BUCKET)
      .download(backup.storage_path);

    if (dlError || !download) {
      await auditRestoreFailure("Could not download backup object", "DOWNLOAD_FAILED");
      throw new Error("Could not download backup object");
    }

    const buffer = await download.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const actualSha = await sha256Hex(bytes);
    if (actualSha !== backup.sha256) {
      await auditRestoreFailure("SHA-256 mismatch", "SHA256_MISMATCH");
      throw new Error("Backup integrity verification failed: SHA-256 mismatch");
    }

    const { manifest, tables } = readArchive(bytes);

    // 3. Create pre_restore safety archive
    let safetyBackupId: string;
    try {
      const safetyBackup = await createBackupArchive({
        kind: "pre_restore",
        createdBy: context.userId,
        note: `Pre-restore safety backup for restoring ${data.id}`,
        prune: false,
      });
      safetyBackupId = safetyBackup.id;
    } catch (e) {
      const errorMsg = `Aborted: Could not create safety backup: ${e instanceof Error ? e.message : String(e)}`;
      await auditRestoreFailure(errorMsg, "SAFETY_BACKUP_FAILED");
      throw new Error(errorMsg, { cause: e });
    }

    // 4. Call backup_restore
    // `tables` is an ARRAY of { name, rows }: backup_restore iterates it with
    // jsonb_array_elements and reads `->>'name'` off each entry. An object map
    // — which this built until it was caught in review — makes that raise
    // "cannot extract elements from an object" and fails every restore on the
    // first statement. The two halves of this feature must agree on one shape.
    // The archive's rows are `unknown[]` by construction — they are whatever the
    // database held — so this is the one place the value has to be widened to
    // `Json` for the RPC signature. Asserted here, at the boundary, rather than
    // typed loosely all the way up.
    const payload = {
      format_version: manifest.format_version,
      schema_fingerprint: manifest.schema_fingerprint,
      archive_id: data.id,
      tables: tables.map((t) => ({ name: t.name, rows: t.rows })),
    } as unknown as Json;

    const { data: report, error: restoreError } = await supabaseAdmin.rpc("backup_restore", {
      _payload: payload,
      _actor: context.userId,
    });

    // 5. سجل التدقيق للنجاح يُكتب داخل backup_restore نفسه، لا هنا.
    //
    // Only the FAILURE row is written here. The success row is the final
    // statement inside `backup_restore`, so it commits atomically with the
    // restored data — an audit write that failed out here would leave a
    // destructive restore with no record of it. Writing one in both places
    // would simply produce two rows for one restore.
    if (restoreError) {
      const { error: auditError } = await supabaseAdmin.rpc("write_audit", {
        p_action: "backup.restore",
        p_entity_type: "backup",
        p_entity_id: data.id,
        p_before: null,
        p_after: { safetyBackupId, error: restoreError.message },
        p_result: "failure",
        p_error_code: "RESTORE_RPC_FAILED",
      });
      if (auditError) {
        console.error(
          `FATAL: Failed to write audit log for restore failure: ${auditError.message}`,
        );
      }
      throw new Error(`Database restore failed: ${restoreError.message}`);
    }

    return { ok: true, report, safetyBackupId };
  });
