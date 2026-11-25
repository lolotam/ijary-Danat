import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import { useBackupList } from "@/hooks/useBackups";
import { useI18n } from "@/i18n/provider";
import { BackupHeroCard } from "@/components/admin/backup/BackupHeroCard";
import { AutoBackupCard } from "@/components/admin/backup/AutoBackupCard";
import { BackupList } from "@/components/admin/backup/BackupList";

export const Route = createFileRoute("/admin/settings/backup")({
  component: BackupSettingsPage,
});

/**
 * صفحة النسخ الاحتياطي والاستعادة: غلاف نحيف يحوي البطاقات الأربع.
 *
 * Thin by design — the cards own all state and mutations. This shell
 * handles only the permission gate, the query, and the layout.
 */
function BackupSettingsPage() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const backupList = useBackupList();

  if (permissions.isLoading)
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.SETTINGS_BACKUP))
    return <p className="text-sm text-destructive">{t("common.notAuthorized")}</p>;

  const backups = backupList.data ?? [];
  const latestBackup = backups[0];

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />

      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("settings.backup.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("settings.backup.subtitle")}</p>
      </div>

      {backupList.error && <p className="text-sm text-destructive">{t("common.error")}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <BackupHeroCard latestBackup={latestBackup} />
        <AutoBackupCard />
      </div>

      {/* Restore rewrites user_roles, so it stays admin-only (migration 230). */}
      <BackupList backups={backups} canRestore={permissions.isAdmin} />
    </div>
  );
}
