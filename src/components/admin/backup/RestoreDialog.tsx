import { useState } from "react";

import { toast } from "sonner";
import { RotateCcw } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import {
  type BackupRecord,
  type RestoreReport,
  useRestoreBackup,
  useRestorePreflight,
  formatBytes,
} from "@/hooks/useBackups";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface RestoreDialogProps {
  /** النسخة المختارة للاستعادة، أو null إذا كان الحوار مغلقاً. */
  backup: BackupRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Phase = "confirm" | "success";

// ────────────────────────────────────────────────────────────────────────────
// Report table sub-component
// ────────────────────────────────────────────────────────────────────────────

/**
 * يعرض جدول تقرير الاستعادة لتفصيل التغييرات التي طرأت على الجداول.
 *
 * Shows the summary of inserted, deleted, skipped, and nulled rows per table
 * returned by the backup_restore RPC.
 */
function RestoreReportTable({ report }: { report: RestoreReport }) {
  const { t } = useI18n();

  const totalSkipped = Object.values(report.skipped_by_table || {}).reduce((a, b) => a + b, 0);
  const totalNulled = report.tables.reduce((acc, row) => acc + (row.nulled || 0), 0);

  return (
    <div className="mt-4 space-y-3">
      <p className="font-semibold text-sm">{t("settings.backup.restore.report")}</p>

      {totalSkipped > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {t("settings.backup.restore.skippedWarning")}
        </div>
      )}

      {totalNulled > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {t("settings.backup.restore.nulledWarning")}
        </div>
      )}

      <div className="max-h-52 overflow-y-auto rounded-md border text-xs">
        <table className="w-full">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th className="px-3 py-1.5 text-start font-medium">{t("common.name")}</th>
              <th className="px-3 py-1.5 text-end font-medium">
                {t("settings.backup.restore.reportDeleted")}
              </th>
              <th className="px-3 py-1.5 text-end font-medium">
                {t("settings.backup.restore.reportInserted")}
              </th>
              <th className="px-3 py-1.5 text-end font-medium">
                {t("settings.backup.restore.reportSkipped")}
              </th>
              <th className="px-3 py-1.5 text-end font-medium">
                {t("settings.backup.restore.reportNulled")}
              </th>
            </tr>
          </thead>
          <tbody>
            {report.tables.map((row) => (
              <tr key={row.name} className="border-t">
                <td className="px-3 py-1 font-mono">{row.name}</td>
                <td className="px-3 py-1 text-end text-muted-foreground">{row.deleted}</td>
                <td className="px-3 py-1 text-end text-emerald-700 dark:text-emerald-400">
                  {row.inserted}
                </td>
                <td
                  className={`px-3 py-1 text-end ${row.skipped > 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                >
                  {row.skipped}
                </td>
                <td
                  className={`px-3 py-1 text-end ${row.nulled > 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                >
                  {row.nulled}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main dialog component
// ────────────────────────────────────────────────────────────────────────────

/**
 * حوار تأكيد الاستعادة: يُوضّح نطاق التأثير قبل التنفيذ ويعرض التقرير بعده.
 *
 * Two-phase design: the first phase shows the blast-radius warning and forces
 * the admin to type "RESTORE"; the second phase shows the per-table report
 * returned by the server. The dialog stays open after success so the admin
 * can read the report before dismissing — auto-closing would hide a
 * skipped_profiles warning they need to see.
 */
export function RestoreDialog({ backup, open, onOpenChange }: RestoreDialogProps) {
  const { t } = useI18n();
  const restore = useRestoreBackup();
  const preflight = useRestorePreflight(open && backup ? backup.id : null);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [typedText, setTypedText] = useState("");
  const [report, setReport] = useState<RestoreReport | null>(null);

  function handleOpenChange(value: boolean) {
    if (restore.isPending) return;

    if (!value) {
      // زرّ الإغلاق أو الضغط خارج الحوار — نُعيد الحوار لحالته الأولى
      setPhase("confirm");
      setTypedText("");
      setReport(null);
    }
    onOpenChange(value);
  }

  async function handleRestore() {
    if (!backup) return;
    try {
      const result = await restore.mutateAsync(backup.id);
      setReport(result.report);
      setPhase("success");
      toast.success(t("settings.backup.restore.success"));
    } catch (error) {
      toast.error(t("settings.backup.restore.error"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  const canConfirm =
    typedText === "RESTORE" &&
    !restore.isPending &&
    !preflight.isPending &&
    !preflight.isError &&
    preflight.data?.restorable === true;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-lg">
        {phase === "confirm" ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                <RotateCcw className="size-5 shrink-0" />
                {t("settings.backup.restore.title")}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm">
                  {preflight.isPending ? (
                    <div className="p-3 text-muted-foreground">{t("common.loading")}</div>
                  ) : preflight.isError ? (
                    <div className="p-3 text-destructive">{t("common.error")}</div>
                  ) : preflight.data ? (
                    <>
                      {/* Preflight Stats */}
                      <p className="font-medium text-foreground">
                        {t("settings.backup.restore.preflightStats")
                          .replace(
                            "{date}",
                            new Date(preflight.data.manifest.created_at).toLocaleString("en-GB"),
                          )
                          .replace("{tables}", preflight.data.manifest.table_count.toString())
                          .replace("{rows}", preflight.data.manifest.row_count.toString())
                          .replace("{size}", formatBytes(preflight.data.manifest.size_bytes))}
                      </p>

                      {/* Not Restorable Error */}
                      {!preflight.data.restorable && (
                        <div className="rounded-md border border-destructive bg-destructive/10 p-3 font-semibold text-destructive">
                          {t("settings.backup.restore.notRestorable")}
                        </div>
                      )}

                      {/* Orphan Logins Consequence */}
                      {preflight.data.orphan_logins > 0 && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                          {t("settings.backup.restore.orphanLogins").replace(
                            "{count}",
                            preflight.data.orphan_logins.toString(),
                          )}
                        </div>
                      )}

                      {/* نطاق التأثير */}
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive dark:text-destructive-foreground">
                        {t("settings.backup.restore.blast")}
                      </div>

                      {/* نسخة الأمان */}
                      <p>
                        {t("settings.backup.restore.safety")}{" "}
                        {t("settings.backup.restore.residualWindow")}
                      </p>

                      {/* الملفات والمستندات */}
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        {t("settings.backup.restore.filesDisclaimer")}
                      </div>

                      {/* حقل التأكيد المكتوب */}
                      <div>
                        <p className="mb-1.5 font-medium text-foreground">
                          {t("settings.backup.restore.typeLabel")}
                        </p>
                        <Input
                          dir="ltr"
                          placeholder="RESTORE"
                          value={typedText}
                          onChange={(e) => setTypedText(e.target.value)}
                          autoComplete="off"
                          disabled={!preflight.data.restorable || restore.isPending}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={restore.isPending} onClick={() => setTypedText("")}>
                {t("settings.backup.restore.cancel")}
              </AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={!canConfirm}
                onClick={(e) => {
                  e.preventDefault();
                  void handleRestore();
                }}
              >
                {restore.isPending
                  ? t("settings.backup.restore.confirming")
                  : t("settings.backup.restore.confirm")}
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-emerald-700 dark:text-emerald-400">
                {t("settings.backup.restore.success")}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div>{report && <RestoreReportTable report={report} />}</div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t("settings.backup.restore.close")}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
