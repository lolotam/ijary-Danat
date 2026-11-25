import { useState, useEffect } from "react";

import { toast } from "sonner";
import { Download, RotateCcw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import {
  type BackupKind,
  type BackupRecord,
  formatBytes,
  useDeleteBackup,
  useDownloadBackup,
} from "@/hooks/useBackups";
import { RestoreDialog } from "./RestoreDialog";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * يُعيد صنف CSS وملصق الشارة بحسب نوع النسخة الاحتياطية.
 *
 * Color-coded in the spec; using Tailwind semantic color classes rather than
 * hex so dark-mode and theme overrides are respected automatically.
 */
function kindMeta(
  kind: BackupKind,
  t: (key: string) => string,
): { label: string; className: string } {
  switch (kind) {
    case "manual":
      return {
        label: t("settings.backup.list.manual"),
        className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      };
    case "automatic":
      return {
        label: t("settings.backup.list.automatic"),
        className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
      };
    case "pre_restore":
      return {
        label: t("settings.backup.list.pre_restore"),
        className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
      };
  }
}

/**
 * يُنسِّق التاريخ والوقت لعرضه في الجدول بصيغة قصيرة.
 */
function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-KW" : "en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

// ────────────────────────────────────────────────────────────────────────────
// Row
// ────────────────────────────────────────────────────────────────────────────

/**
 * صف واحد في جدول النسخ الاحتياطية مع أزرار الإجراءات ومعلومات إضافية عند التحويم.
 */
function BackupRow({
  backup,
  onDeleteRequest,
  onRestoreRequest,
}: {
  backup: BackupRecord;
  onDeleteRequest: (b: BackupRecord) => void;
  /** غائب لمن لا يملك صلاحية الاستعادة، فيُخفى الزر. */
  onRestoreRequest?: (b: BackupRecord) => void;
}) {
  const { t, locale } = useI18n();
  const download = useDownloadBackup();
  const { label, className } = kindMeta(backup.kind, t);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  async function handleDownload() {
    try {
      const url = await download.mutateAsync(backup.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(t("settings.backup.list.downloadError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <TooltipProvider>
      {/* Hover detail is a CSS-group-hover pattern — no JS state needed. */}
      <tr className="group border-t transition-colors hover:bg-muted/40">
        <td className="px-4 py-3">
          <p className="text-sm font-medium">
            {mounted ? formatDateTime(backup.created_at, locale) : "—"}
          </p>
          {/* Hover-revealed extra detail */}
          <div className="mt-1 hidden space-y-0.5 text-xs text-muted-foreground group-hover:block">
            <p dir="ltr">{backup.created_at}</p>
            {backup.created_by && (
              <p>
                {t("settings.backup.list.createdBy")}: {backup.created_by.slice(0, 8)}…
              </p>
            )}
            {backup.note && (
              <p>
                {t("settings.backup.list.note")}: {backup.note}
              </p>
            )}
          </div>
        </td>

        <td className="px-4 py-3">
          <Badge variant="outline" className={className}>
            {label}
          </Badge>
        </td>

        <td className="px-4 py-3 text-sm tabular-nums">{formatBytes(backup.size_bytes)}</td>
        <td className="px-4 py-3 text-sm tabular-nums text-end">{backup.table_count}</td>
        <td className="px-4 py-3 text-sm tabular-nums text-end">
          {backup.row_count.toLocaleString()}
        </td>

        {/* Actions — safe and destructive are separated visually */}
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1">
            {/* Download — safe action */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  disabled={download.isPending}
                  onClick={() => void handleDownload()}
                  aria-label={t("settings.backup.list.download")}
                >
                  <Download className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("settings.backup.list.downloadTip")}</TooltipContent>
            </Tooltip>

            {/* Visual separator between safe and destructive */}
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />

            {/* Restore — destructive */}
            {onRestoreRequest && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:hover:bg-amber-950"
                    onClick={() => onRestoreRequest(backup)}
                    aria-label={t("settings.backup.list.restore")}
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("settings.backup.list.restoreTip")}</TooltipContent>
              </Tooltip>
            )}

            {/* Delete — destructive */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:bg-destructive/10"
                  onClick={() => onDeleteRequest(backup)}
                  aria-label={t("settings.backup.list.delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("settings.backup.list.deleteTip")}</TooltipContent>
            </Tooltip>
          </div>
        </td>
      </tr>
    </TooltipProvider>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Delete confirmation dialog
// ────────────────────────────────────────────────────────────────────────────

/**
 * حوار تأكيد حذف نسخة احتياطية واحدة.
 */
function DeleteConfirmDialog({
  backup,
  open,
  onOpenChange,
}: {
  backup: BackupRecord | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const deleteBackup = useDeleteBackup();

  async function handleDelete() {
    if (!backup) return;
    try {
      await deleteBackup.mutateAsync(backup.id);
      toast.success(t("settings.backup.list.deleteSuccess"));
      onOpenChange(false);
    } catch (error) {
      toast.error(t("settings.backup.list.deleteError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("settings.backup.list.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {backup?.file_name && (
              <span className="block font-mono text-xs mb-2">{backup.file_name}</span>
            )}
            {t("settings.backup.list.deleteDesc")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteBackup.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleDelete();
            }}
            disabled={deleteBackup.isPending}
            className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
          >
            {deleteBackup.isPending ? t("common.loading") : t("settings.backup.list.deleteOk")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Public card
// ────────────────────────────────────────────────────────────────────────────

/**
 * بطاقة أرشيف النسخ الاحتياطية: جدول بكامل النسخ مع إجراءات التنزيل والاستعادة والحذف.
 */
export function BackupList({
  backups,
  canRestore,
}: {
  backups: BackupRecord[];
  canRestore: boolean;
}) {
  const { t } = useI18n();
  const [deleteTarget, setDeleteTarget] = useState<BackupRecord | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("settings.backup.list.title")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {backups.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">
            {t("settings.backup.list.empty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="backup-table">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium">
                    {t("settings.backup.list.date")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium">
                    {t("settings.backup.list.kind")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium">
                    {t("settings.backup.list.size")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {t("settings.backup.list.tables")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {t("settings.backup.list.rows")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {t("settings.backup.list.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <BackupRow
                    key={b.id}
                    backup={b}
                    onDeleteRequest={setDeleteTarget}
                    onRestoreRequest={canRestore ? setRestoreTarget : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <DeleteConfirmDialog
        backup={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
      />
      <RestoreDialog
        backup={restoreTarget}
        open={restoreTarget !== null}
        onOpenChange={(v) => {
          if (!v) setRestoreTarget(null);
        }}
      />
    </Card>
  );
}
