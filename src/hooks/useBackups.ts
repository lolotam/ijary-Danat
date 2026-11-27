import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createBackup, deleteBackup, downloadBackupUrl, listBackups } from "@/fns/backup";
import { backupRestorePreflight, restoreBackup } from "@/fns/restoreBackup";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type BackupKind = "manual" | "automatic" | "pre_restore";

/**
 * صف نسخة احتياطية واحدة كما يُعاد من الخادم.
 *
 * Kept here rather than imported from database.types.ts because that file is
 * hand-maintained and owned by the schema slice — tying this feature slice to
 * its edit cadence would couple two independent delivery streams.
 */
export type BackupRecord = {
  id: string;
  file_name: string;
  storage_path: string;
  sha256: string; // تجزئة SHA-256 تُتحقق منها قبل الاستعادة (§3.1)
  size_bytes: number;
  table_count: number;
  row_count: number;
  kind: BackupKind;
  period_key: string | null; // مفتاح الفترة: للنسخ التلقائية، ومفتاح المهمة للنسخ المرتبطة بمهمة
  note: string | null;
  created_by: string | null;
  created_at: string;
};

/**
 * نتيجة الفحص المسبق للاستعادة.
 *
 * Returned by `backupRestorePreflight` (Slice C) before the destructive
 * operation begins so the admin sees the orphan-login count before they
 * commit — not after the fact (§6.5).
 */
export type PreflightResult = {
  ok: boolean;
  manifest: {
    file_name: string;
    created_at: string;
    table_count: number;
    row_count: number;
    size_bytes: number;
  };
  orphan_logins: number;
  restorable: boolean;
};

// ────────────────────────────────────────────────────────────────────────────
// Shared query key — prefix match keeps all backup invalidations in one place.
// ────────────────────────────────────────────────────────────────────────────

export const BACKUPS_QUERY_KEY = ["backups"] as const;

// ────────────────────────────────────────────────────────────────────────────
// Utilities exported so cards don't duplicate the formatting logic.
// ────────────────────────────────────────────────────────────────────────────

/**
 * يُنسِّق حجم الملف من البايت إلى وحدة قابلة للقراءة.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ────────────────────────────────────────────────────────────────────────────
// Hooks
// ────────────────────────────────────────────────────────────────────────────

/**
 * يجلب قائمة النسخ الاحتياطية مرتبةً من الأحدث للأقدم.
 */
export function useBackupList() {
  return useQuery({
    queryKey: BACKUPS_QUERY_KEY,
    queryFn: async (): Promise<BackupRecord[]> => {
      const result = await listBackups();
      return result.records as BackupRecord[];
    },
  });
}

/**
 * يحجز إنشاء نسخة احتياطية يدوية في العامل ويُبطل القائمة عند الحجز.
 *
 * The archive is created out of the request now (`company.export`): the
 * mutation resolves as soon as the job is queued, and the backup appears in
 * the list once the worker finishes.
 */
export function useCreateBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<{ queued: true; jobRequestId: string }> => {
      return await createBackup();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY });
    },
  });
}

/**
 * يحذف نسخة احتياطية بمعرّفها ويُبطل القائمة عند النجاح.
 */
export function useDeleteBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await deleteBackup({ data: { id } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY });
    },
  });
}

/**
 * يُجري الفحص المسبق للاستعادة: يحصي حسابات الدخول التي لا يقابلها ملف
 * شخصي في الأرشيف، قبل بدء العملية التدميرية.
 *
 * Enabled only when an id is provided (dialog open with a target selected).
 * If this query fails the restore confirm button stays disabled — the admin
 * must know the orphan-login count before proceeding; silently ignoring a
 * failed preflight is not acceptable (§6.5).
 */
export function useRestorePreflight(id: string | null) {
  return useQuery({
    queryKey: ["backup-preflight", id],
    queryFn: async (): Promise<PreflightResult> => {
      return await backupRestorePreflight({ data: { id: id! } });
    },
    enabled: id !== null,
    staleTime: 0,
    retry: 1,
  });
}

/**
 * يحجز استعادة قاعدة البيانات من نسخة احتياطية محددة في العامل.
 *
 * The `confirm: "RESTORE"` token is enforced server-side in addition to the
 * typed-confirmation UI — a double gate so an accidental programmatic call
 * cannot bypass the dialog. The restore itself runs out of the request now
 * (`company.restore`), so the mutation resolves when the job is queued and
 * the outcome arrives as the platform's notice.
 *
 * Full cache invalidation (no filter) is kept on purpose: the queued restore
 * replaces every row in the database, and every cached query is stale from
 * the moment it lands.
 */
export function useRestoreBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<{ queued: true; jobRequestId: string }> => {
      return await restoreBackup({ data: { id, confirm: "RESTORE" } });
    },
    onSuccess: () => {
      // A restore replaces every row in the database. Every cached query is
      // now stale regardless of its query key — scoping this invalidation
      // would silently serve the admin pre-restore data after the operation.
      void queryClient.invalidateQueries();
    },
  });
}

/**
 * يطلب رابطاً موقَّتاً (٦٠ ثانية) لتنزيل ملف النسخة الاحتياطية.
 *
 * Returns the URL as the mutation result so the caller can open it —
 * side-effecting `window.open` stays out of the hook to keep it testable.
 */
export function useDownloadBackup() {
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const result = await downloadBackupUrl({ data: { id } });
      return result.url;
    },
  });
}
