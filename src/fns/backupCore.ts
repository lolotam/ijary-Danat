import { serverCompanyClient } from "@/company/companyClient.server";
import { companyStoragePath } from "@/company/storagePath";
import {
  BACKUP_FORMAT_VERSION,
  buildArchive,
  backupFileName,
  sha256Hex,
  pruneTargets,
} from "@/lib/backupArchive";
import type { BackupKind } from "@/lib/backupArchive";

export const BACKUP_BUCKET = "backups";
export const BACKUP_RETENTION_KEEP = 10;
export const BACKUP_RETENTION_KEEP_PRE_RESTORE = 5;

export class BackupInsertError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BackupInsertError";
    this.code = code;
  }
}

export type BackupRecord = {
  id: string;
  file_name: string;
  storage_path: string;
  sha256: string;
  size_bytes: number;
  table_count: number;
  row_count: number;
  kind: BackupKind;
  period_key: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

/**
 * ينشئ أرشيف نسخة احتياطية جديدة ويسجله في قاعدة البيانات.
 *
 * One dump call is made to ensure consistency. The uploaded storage object is
 * deleted if the database record insertion fails to prevent orphaned files.
 * Pruning drops older backups by deleting the row first, then the storage object.
 */
export async function createBackupArchive(options: {
  companyId?: string;
  kind: BackupKind;
  createdBy: string | null;
  note?: string | null;
  periodKey?: string | null;
  prune?: boolean;
  now?: Date;
}): Promise<BackupRecord> {
  const {
    companyId: explicitCompanyId,
    kind,
    createdBy,
    note = null,
    periodKey = null,
    prune = true,
    now = new Date(),
  } = options;
  const { companyId, client } = serverCompanyClient(explicitCompanyId);

  // 1. One dump call
  const { data: dump, error: dumpError } = await client.rpc("backup_dump_all");
  if (dumpError) throw new Error(`Backup dump failed: ${dumpError.message}`);

  // 2. Build archive
  //
  // `tables` is an ARRAY of { name, rows }, which is the shape both
  // backup_dump_all and backup_restore speak. Reading it as an object map —
  // Object.entries over an array yields ["0", {…}] — produced a table literally
  // named "0" whose rows were the wrapper object. It is the one shape the two
  // halves of this feature have to agree on, so it is asserted rather than
  // assumed.
  const dumpPayload = dump as {
    format_version: number;
    schema_fingerprint: string;
    tables: Array<{ name: string; rows: unknown[] }>;
  };
  if (!Array.isArray(dumpPayload?.tables)) {
    throw new Error("backup_dump_all returned an unexpected shape: `tables` is not an array.");
  }
  const { schema_fingerprint, tables } = dumpPayload;
  const tableData = tables.map(({ name, rows }) => ({ name, rows }));

  const { bytes, manifest } = buildArchive(tableData, {
    kind,
    createdAt: now,
    schemaFingerprint: schema_fingerprint,
  });

  const sha256 = await sha256Hex(bytes);
  const fileName = backupFileName(now);
  const id = crypto.randomUUID();
  // مجلد `backups/` داخل الحاوية، واسم الملف معرّف فريد لا طابع زمني.
  //
  // A uuid rather than the friendly timestamp, because two runs starting in the
  // same minute would collide on a minute-resolution name. The readable name
  // lives in `file_name`, which is what the archive downloads as.
  const storagePath = companyStoragePath(companyId, `backups/${id}.zip`);

  // 3. Upload to storage
  const { error: uploadError } = await client.storage
    .from(BACKUP_BUCKET)
    .upload(storagePath, bytes, { contentType: "application/zip", upsert: false });

  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  // 4. Insert row
  const { data: row, error: insertError } = await client
    .from("backups")
    .insert({
      id,
      company_id: companyId,
      file_name: fileName,
      storage_path: storagePath,
      sha256,
      size_bytes: bytes.byteLength,
      table_count: manifest.tables.length,
      row_count: manifest.row_count,
      kind,
      period_key: periodKey,
      note,
      created_by: createdBy,
      created_at: now.toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    const { data: existingRow, error: fetchError } = await client
      .from("backups")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (fetchError || existingRow) {
      throw new BackupInsertError(
        `Database insert returned an error but the row state is ambiguous. Storage object was preserved. Error: ${insertError.message}`,
        insertError.code,
      );
    }

    const { error: cleanupError } = await client.storage.from(BACKUP_BUCKET).remove([storagePath]);

    if (cleanupError) {
      throw new BackupInsertError(
        `Database insert failed: ${insertError.message}. Also failed to clean up storage object: ${cleanupError.message}`,
        insertError.code,
      );
    }

    throw new BackupInsertError(`Database insert failed: ${insertError.message}`, insertError.code);
  }

  // 5. Audit log
  const { error: auditError } = await client.rpc("write_audit", {
    p_action: "backup.create",
    p_entity_type: "backup",
    p_entity_id: id,
    p_before: null,
    p_after: { company_id: companyId, file_name: fileName, kind, size_bytes: bytes.byteLength },
    p_result: "success",
    p_error_code: null,
  });

  if (auditError) {
    console.error(`FATAL: Failed to write audit log for backup creation: ${auditError.message}`);
    throw new Error(`Failed to write audit log for backup creation: ${auditError.message}`);
  }

  // 6. Prune if needed
  if (prune) {
    try {
      const { data: allBackups } = await client.from("backups").select("*");

      if (allBackups) {
        const toPrune = pruneTargets(allBackups, {
          keep: BACKUP_RETENTION_KEEP,
          keepPreRestore: BACKUP_RETENTION_KEEP_PRE_RESTORE,
        });

        for (const backup of toPrune) {
          await deleteBackupRecord(backup.id, companyId);
        }
      }
    } catch (err) {
      console.error("Pruning failed", err);
      // Pruning failures are logged and swallowed
    }
  }

  return row as BackupRecord;
}

/**
 * يحذف نسخة احتياطية من قاعدة البيانات ومن مساحة التخزين.
 *
 * Deletes the row first, then the object, so a failure leaves an orphaned
 * file rather than a row pointing to a missing file.
 */
export async function deleteBackupRecord(id: string, explicitCompanyId?: string): Promise<void> {
  const { companyId, client } = serverCompanyClient(explicitCompanyId);
  const { data: backup, error: fetchError } = await client
    .from("backups")
    .select("storage_path, file_name")
    .eq("id", id)
    .single();

  if (fetchError) throw new Error(`Fetch failed: ${fetchError.message}`);

  const { error: deleteError } = await client.from("backups").delete().eq("id", id);

  if (deleteError) throw new Error(`Row deletion failed: ${deleteError.message}`);

  const { error: removeError } = await client.storage
    .from(BACKUP_BUCKET)
    .remove([backup.storage_path]);

  if (removeError) {
    console.error(`Failed to remove storage object ${backup.storage_path}: ${removeError.message}`);
  }

  const { error: auditError } = await client.rpc("write_audit", {
    p_action: "backup.delete",
    p_entity_type: "backup",
    p_entity_id: id,
    p_before: { file_name: backup.file_name },
    p_after: removeError
      ? { company_id: companyId, error: removeError.message }
      : { company_id: companyId },
    p_result: removeError ? "partial_failure" : "success",
    p_error_code: removeError ? "STORAGE_DELETE_FAILED" : null,
  });

  if (auditError) {
    console.error(`FATAL: Failed to write audit log for backup deletion: ${auditError.message}`);
    throw new Error(`Failed to write audit log for backup deletion: ${auditError.message}`);
  }
}

/**
 * يسرد جميع النسخ الاحتياطية الموجودة للشركة الحالية.
 *
 * Retrieves all backups for the UI, ordered by creation date descending.
 */
export async function listBackupRecords(explicitCompanyId?: string): Promise<BackupRecord[]> {
  const { client } = serverCompanyClient(explicitCompanyId);
  const { data, error } = await client
    .from("backups")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`List failed: ${error.message}`);
  return data as BackupRecord[];
}
