import { useState, useEffect } from "react";

import { toast } from "sonner";
import { DatabaseZap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/provider";
import { formatBytes, type BackupRecord, useCreateBackup } from "@/hooks/useBackups";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * يُنسِّق الوقت النسبي (مثل «منذ ساعتين») من تاريخ ISO.
 */
function formatRelativeTime(iso: string, locale: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const rtf = new Intl.RelativeTimeFormat(locale === "ar" ? "ar-KW" : "en", { numeric: "auto" });
  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  if (minutes > 0) return rtf.format(-minutes, "minute");
  return rtf.format(-seconds, "second");
}

// ────────────────────────────────────────────────────────────────────────────
// Last-backup stat row
// ────────────────────────────────────────────────────────────────────────────

/**
 * يعرض ملخصاً للنسخة الاحتياطية الأخيرة: الوقت والجداول والسجلات والحجم.
 */
function LastBackupSummary({ last }: { last: BackupRecord }) {
  const { t, locale } = useI18n();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const stats = [
    { label: t("settings.backup.hero.tables"), value: last.table_count },
    { label: t("settings.backup.hero.rows"), value: last.row_count.toLocaleString() },
    { label: t("settings.backup.hero.size"), value: formatBytes(last.size_bytes) },
  ];

  return (
    <div className="rounded-xl border bg-muted/30 p-4 space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {t("settings.backup.hero.lastBackup")}
      </p>
      <p className="text-2xl font-bold tracking-tight">
        {mounted ? formatRelativeTime(last.created_at, locale) : "—"}
      </p>
      <div className="flex flex-wrap gap-4 pt-1">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col">
            <span className="text-xl font-semibold tabular-nums">{s.value}</span>
            <span className="text-xs text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Public card
// ────────────────────────────────────────────────────────────────────────────

/**
 * بطاقة «أنشئ نسخة احتياطية الآن»: زر كبير، وملاحظة عما تشمله النسخة وما لا تشمله،
 * وملخص النسخة الأخيرة.
 *
 * The content-exclusion note (no files, no passwords) is a product requirement,
 * not decoration — a user who believes their property images are in the backup
 * is being misled. It must be present and prominent.
 *
 * The backup is created by the worker now, so the button reports the job as
 * queued; the note field that used to sit here is gone because the job payload
 * carries ids only (contracts/jobs.md section 1) and a field the worker never
 * sees must not be asked for.
 */
export function BackupHeroCard({ latestBackup }: { latestBackup: BackupRecord | undefined }) {
  const { t } = useI18n();
  const createBackup = useCreateBackup();

  async function handleBackup() {
    try {
      await createBackup.mutateAsync();
      toast.success(t("settings.backup.hero.queued"));
    } catch (error) {
      toast.error(t("settings.backup.hero.error"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <Card className="overflow-hidden border-0 bg-gradient-to-br from-primary/5 via-background to-background shadow-sm ring-1 ring-border">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <DatabaseZap className="size-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-xl">{t("settings.backup.hero.title")}</CardTitle>
            <CardDescription className="mt-0.5">
              {t("settings.backup.hero.description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Last backup summary or placeholder */}
        {latestBackup ? (
          <LastBackupSummary last={latestBackup} />
        ) : (
          <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground text-center">
            {t("settings.backup.hero.noBackup")}
          </div>
        )}

        {/* Content-exclusion note — explicit product requirement */}
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {t("settings.backup.hero.contentNote")}
        </div>

        <Button
          size="lg"
          className="w-full gap-2"
          disabled={createBackup.isPending}
          onClick={() => void handleBackup()}
        >
          <DatabaseZap className="size-4" />
          {createBackup.isPending
            ? t("settings.backup.hero.backing")
            : t("settings.backup.hero.backupNow")}
        </Button>
      </CardContent>
    </Card>
  );
}
