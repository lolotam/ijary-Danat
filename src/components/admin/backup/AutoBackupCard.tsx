import { toast } from "sonner";
import { CalendarClock, CalendarDays } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/provider";
import { useCompany, useUpdateCompany } from "@/hooks/useCompany";

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

/**
 * بطاقة النسخ الاحتياطي التلقائي: مفتاحان (يومي، أسبوعي) متنافيان تُجمَعان في
 * طلب تحديث واحد لتفادي انتهاك قيد قاعدة البيانات.
 *
 * The DB CHECK enforces `not (backup_daily_enabled and backup_weekly_enabled)`.
 * Two sequential mutations would momentarily violate it and fail on the second
 * write. A single mutation with both fields avoids the race entirely.
 */
export function AutoBackupCard() {
  const { t } = useI18n();
  const companyQuery = useCompany();
  const updateCompany = useUpdateCompany();

  const company = companyQuery.data;
  const daily = company?.backup_daily_enabled ?? false;
  const weekly = company?.backup_weekly_enabled ?? false;
  const isPending = updateCompany.isPending;

  /**
   * يُفعِّل الجدول المحدد ويُوقف الآخر في طلب واحد.
   */
  async function toggle(schedule: "daily" | "weekly", value: boolean) {
    if (!company) return;

    const updates =
      value && schedule === "daily"
        ? { backup_daily_enabled: true, backup_weekly_enabled: false }
        : value && schedule === "weekly"
          ? { backup_daily_enabled: false, backup_weekly_enabled: true }
          : schedule === "daily"
            ? { backup_daily_enabled: false, backup_weekly_enabled: weekly }
            : { backup_daily_enabled: daily, backup_weekly_enabled: false };

    try {
      await updateCompany.mutateAsync({ id: company.id, updates });
      const key =
        value && schedule === "daily"
          ? "settings.backup.auto.savedaily"
          : value && schedule === "weekly"
            ? "settings.backup.auto.saveweekly"
            : "settings.backup.auto.disabled";
      toast.success(t(key));
    } catch (error) {
      toast.error(t("settings.backup.auto.error"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  if (companyQuery.isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {t("common.loading")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("settings.backup.auto.title")}</CardTitle>
        <CardDescription>{t("settings.backup.auto.description")}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Mutual-exclusion notice */}
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {t("settings.backup.auto.mutualNote")}
        </p>

        {/* Daily */}
        <div
          className={`flex items-start justify-between gap-4 rounded-lg border p-3 transition-colors ${
            daily ? "border-primary/30 bg-primary/5" : ""
          }`}
        >
          <div className="flex items-start gap-2.5">
            <CalendarDays className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium leading-none">{t("settings.backup.auto.daily")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.backup.auto.dailyNote")}
              </p>
            </div>
          </div>
          <Switch
            checked={daily}
            disabled={isPending || companyQuery.isLoading}
            onCheckedChange={(v) => void toggle("daily", v)}
            aria-label={t("settings.backup.auto.daily")}
          />
        </div>

        {/* Weekly */}
        <div
          className={`flex items-start justify-between gap-4 rounded-lg border p-3 transition-colors ${
            weekly ? "border-primary/30 bg-primary/5" : ""
          }`}
        >
          <div className="flex items-start gap-2.5">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium leading-none">{t("settings.backup.auto.weekly")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.backup.auto.weeklyNote")}
              </p>
            </div>
          </div>
          <Switch
            checked={weekly}
            disabled={isPending || companyQuery.isLoading}
            onCheckedChange={(v) => void toggle("weekly", v)}
            aria-label={t("settings.backup.auto.weekly")}
          />
        </div>

        {/* Retention note */}
        <p className="text-xs text-muted-foreground ps-1">{t("settings.backup.auto.retention")}</p>
      </CardContent>
    </Card>
  );
}
