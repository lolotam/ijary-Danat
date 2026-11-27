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

type Phase = "confirm" | "queued";

// ────────────────────────────────────────────────────────────────────────────
// Main dialog component
// ────────────────────────────────────────────────────────────────────────────

/**
 * حوار تأكيد الاستعادة: يُوضّح نطاق التأثير قبل التنفيذ ويؤكد الحجز بعده.
 *
 * Two-phase design: the first phase shows the blast-radius warning and forces
 * the admin to type "RESTORE"; the second confirms the job was queued. The
 * restore runs in the worker now, so its per-table report arrives as the
 * platform's notice rather than inline in this dialog.
 */
export function RestoreDialog({ backup, open, onOpenChange }: RestoreDialogProps) {
  const { t } = useI18n();
  const restore = useRestoreBackup();
  const preflight = useRestorePreflight(open && backup ? backup.id : null);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [typedText, setTypedText] = useState("");

  function handleOpenChange(value: boolean) {
    if (restore.isPending) return;

    if (!value) {
      // زرّ الإغلاق أو الضغط خارج الحوار — نُعيد الحوار لحالته الأولى
      setPhase("confirm");
      setTypedText("");
    }
    onOpenChange(value);
  }

  async function handleRestore() {
    if (!backup) return;
    try {
      await restore.mutateAsync(backup.id);
      setPhase("queued");
      toast.success(t("settings.backup.restore.queued"));
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
                {t("settings.backup.restore.queued")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.backup.restore.queuedHint")}
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
