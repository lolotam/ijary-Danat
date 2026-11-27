import { companyClient } from "@/company/companyClient.server";
import type { Json } from "@/integrations/supabase/database.types";
import { BACKUP_BUCKET, createBackupArchive } from "@/fns/backupCore";
import { readArchive, sha256Hex } from "@/lib/backupArchive";

/** ما تحتاجه الاستعادة من مُنفِّذها: الشركة والنسخة والفاعل ومعرّف المهمة. */
export interface PerformRestoreInput {
  companyId: string;
  backupId: string;
  /** الموظف الذي طلب الاستعادة؛ يُسجَّل فاعلاً لنسخة الأمان ولمعامل الاستعادة. */
  actor: string;
  /**
   * معرّف طلب المهمة الذي تُربط به الاستعادة.
   *
   * The pre-restore safety archive is keyed to it (`period_key`), so the row
   * is the marker a retry of the same job reads before restoring again.
   */
  jobRequestId: string;
}

/**
 * ينفّذ الاستعادة التدميرية من نسخة احتياطية: يتحقق من التجزئة، وينشئ نسخة
 * أمان، ثم يستدعي استعادة قاعدة البيانات.
 *
 * Moved out of the server function when the restore became the `company.restore`
 * job: this is the destructive work itself, and both the job handler and its
 * tests drive this one implementation (`move, not copy`).
 *
 * Lives in a `.server.ts` module so `restoreBackup.ts`, which the backups
 * screen imports for its server functions, never pulls the company client or
 * the archive writer into the browser bundle.
 *
 * Idempotent per job id: the pre-restore safety archive carries the job id as
 * its period key, so a second run of the same job finds that row and stops
 * before restoring twice. The unique `(company_id, kind, period_key)` index is
 * the race behind that check.
 */
export async function performRestore(input: PerformRestoreInput): Promise<{
  report: unknown;
  safetyBackupId: string;
}> {
  const { companyId, backupId, actor, jobRequestId } = input;
  const db = companyClient(companyId);

  /** يسجّل فشل الاستعادة في سجل التدقيق دون أن يخفي الخطأ الأصلي. */
  async function auditRestoreFailure(errorMsg: string, errorCode: string) {
    const { error } = await db.rpc("write_audit", {
      p_action: "backup.restore",
      p_entity_type: "backup",
      p_entity_id: backupId,
      p_before: null,
      p_after: { error: errorMsg },
      p_result: "failure",
      p_error_code: errorCode,
    });
    if (error) {
      console.error(`FATAL: Failed to write audit log for restore failure: ${error.message}`);
    }
  }

  const { data: backup, error: fetchError } = await db
    .from("backups")
    .select("storage_path, sha256")
    .eq("id", backupId)
    .single();

  if (fetchError || !backup) {
    await auditRestoreFailure("Backup not found", "BACKUP_NOT_FOUND");
    throw new Error("Backup not found");
  }

  const { data: download, error: dlError } = await db.storage
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
      companyId,
      kind: "pre_restore",
      createdBy: actor,
      note: `Pre-restore safety backup for restoring ${backupId}`,
      periodKey: jobRequestId,
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
    archive_id: backupId,
    tables: tables.map((t) => ({ name: t.name, rows: t.rows })),
  } as unknown as Json;

  const { data: report, error: restoreError } = await db.rpc("backup_restore", {
    _payload: payload,
    _actor: actor,
  });

  // 5. سجل التدقيق للنجاح يُكتب داخل backup_restore نفسه، لا هنا.
  //
  // Only the FAILURE row is written here. The success row is the final
  // statement inside `backup_restore`, so it commits atomically with the
  // restored data — an audit write that failed out here would leave a
  // destructive restore with no record of it. Writing one in both places
  // would simply produce two rows for one restore.
  if (restoreError) {
    const { error: auditError } = await db.rpc("write_audit", {
      p_action: "backup.restore",
      p_entity_type: "backup",
      p_entity_id: backupId,
      p_before: null,
      p_after: { safetyBackupId, error: restoreError.message },
      p_result: "failure",
      p_error_code: "RESTORE_RPC_FAILED",
    });
    if (auditError) {
      console.error(`FATAL: Failed to write audit log for restore failure: ${auditError.message}`);
    }
    throw new Error(`Database restore failed: ${restoreError.message}`);
  }

  return { report, safetyBackupId };
}
