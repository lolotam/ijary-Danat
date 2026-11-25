import { useState } from "react";
import { toast } from "sonner";

import { DeleteConfirmation } from "@/components/admin/Phase2Ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCompany } from "@/hooks/useCompany";
import {
  DEFAULT_RETENTION_DAYS,
  RETENTION_DAY_OPTIONS,
  useSetLogRetention,
  type RetentionLog,
} from "@/hooks/useLogRetention";
import { useI18n } from "@/i18n/provider";

/**
 * بطاقة الحذف التلقائي لسجل (التدقيق أو الإشعارات): مفتاح تفعيل ومدة احتفاظ.
 *
 * Turning it on or shortening the window deletes rows immediately and for
 * good, so both go through a confirmation; turning it off deletes nothing and
 * applies at once. `canManage` mirrors the server check in `set_log_retention`
 * — the server stays the authority, this only avoids offering a button that
 * would be refused.
 */
export function LogRetentionCard({ log, canManage }: { log: RetentionLog; canManage: boolean }) {
  const { t } = useI18n();
  const company = useCompany();
  const setRetention = useSetLogRetention();
  const [pendingDays, setPendingDays] = useState<number | null>(null);

  const current =
    log === "audit"
      ? company.data?.audit_log_retention_days
      : company.data?.notification_log_retention_days;
  const enabled = current !== null && current !== undefined;
  const disabled = !canManage || company.isLoading || setRetention.isPending;

  /** يرسل المدة للخادم ويعرض عدد السجلات المحذوفة. */
  async function apply(days: number | null) {
    try {
      const result = await setRetention.mutateAsync({ log, days });
      toast.success(
        days === null
          ? t("logRetention.disabled")
          : t("logRetention.saved").replace("{count}", String(result.deleted)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    } finally {
      setPendingDays(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("logRetention.title")}</CardTitle>
        <CardDescription>
          {log === "audit"
            ? t("logRetention.auditDescription")
            : t("logRetention.notificationsDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <Switch
            id={`retention-${log}`}
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              checked ? setPendingDays(DEFAULT_RETENTION_DAYS[log]) : void apply(null)
            }
          />
          <Label htmlFor={`retention-${log}`}>{t("logRetention.enabled")}</Label>
        </div>
        <div className="flex items-center gap-3">
          <Label>{t("logRetention.keep")}</Label>
          <Select
            value={enabled ? String(current) : "off"}
            disabled={disabled || !enabled}
            onValueChange={(value) => setPendingDays(Number(value))}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!enabled && <SelectItem value="off">{t("logRetention.off")}</SelectItem>}
              {RETENTION_DAY_OPTIONS[log].map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t(`logRetention.weeks.${days}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!canManage && log === "audit" && (
          <p className="text-sm text-muted-foreground">{t("logRetention.adminOnly")}</p>
        )}
      </CardContent>
      <DeleteConfirmation
        open={pendingDays !== null}
        pending={setRetention.isPending}
        title={t("logRetention.confirmTitle")}
        description={t("logRetention.confirmBody")}
        close={() => setPendingDays(null)}
        confirm={() => void apply(pendingDays)}
      />
    </Card>
  );
}
