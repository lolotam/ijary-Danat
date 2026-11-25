import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { useNotifications } from "@/hooks/useNotifications";
import { useI18n } from "@/i18n/provider";
import type {
  NotificationAudience,
  NotificationChannel,
  NotificationState,
  NotificationType,
} from "@/integrations/supabase/database.types";
import { exportRecordsToCsv } from "@/lib/csv";
import type { NotificationPoolFilterState } from "./useNotificationPoolFilters";

const notificationTypes: NotificationType[] = [
  "due_reminder",
  "overdue_reminder",
  "receipt",
  "contract_expiry",
  "scheduled_report",
  "document_send",
  "manual_message",
  "deposit_confirmation",
  "user_credentials",
  "payment_admin_alert",
  "company_info",
  "contact_inquiry",
  "maintenance_request",
  "refund_recorded",
  "contract_created",
  "contract_ended",
  "contract_closeout",
  "contract_restored",
  "invoice_written_off",
  "invoice_disputed",
  "whatsapp_session_alert",
];
const channels: NotificationChannel[] = ["email", "whatsapp", "both"];
const states: NotificationState[] = [
  "queued",
  "sent",
  "failed",
  "skipped",
  "cancelled",
  "needs_review",
];

/**
 * شريط مرشّحات سجل الإشعارات مع زر تصدير الصفحة الحالية إلى CSV.
 *
 * Every filter change resets the pager to page 1, so a narrowed result set is
 * never shown from a page index that no longer exists.
 */
export function NotificationPoolFilters({
  filters,
  setPage,
  notifications,
  canExport,
}: {
  filters: NotificationPoolFilterState;
  setPage: (page: number) => void;
  notifications: ReturnType<typeof useNotifications>;
  canExport: boolean;
}) {
  const { t } = useI18n();
  const {
    search,
    setSearch,
    type,
    setType,
    channel,
    setChannel,
    state,
    setState,
    from,
    setFrom,
    to,
    setTo,
    audience,
    setAudience,
    recipient,
    setRecipient,
    sender,
    setSender,
  } = filters;
  return (
    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
      <Input
        className="h-9 min-w-[10rem] shrink-0 basis-[10rem]"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setPage(1);
        }}
        placeholder={t("notifications.search")}
      />
      <Select
        value={audience}
        onValueChange={(value) => {
          setAudience(value as NotificationAudience | "all");
          setPage(1);
        }}
      >
        <SelectTrigger className="h-9 w-[8.5rem] shrink-0">
          <SelectValue placeholder={t("notifications.audience")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("common.all")}</SelectItem>
          <SelectItem value="admin">{t("notifications.audienceAdmin")}</SelectItem>
          <SelectItem value="tenant">{t("notifications.audienceTenant")}</SelectItem>
        </SelectContent>
      </Select>
      <Input
        className="h-9 min-w-[8rem] shrink-0 basis-[8rem]"
        value={recipient}
        onChange={(event) => {
          setRecipient(event.target.value);
          setPage(1);
        }}
        placeholder={t("notifications.to")}
      />
      <Input
        className="h-9 min-w-[8rem] shrink-0 basis-[8rem]"
        value={sender}
        onChange={(event) => {
          setSender(event.target.value);
          setPage(1);
        }}
        placeholder={t("notifications.from")}
      />
      <Select
        value={type}
        onValueChange={(value) => {
          setType(value as NotificationType | "all");
          setPage(1);
        }}
      >
        <SelectTrigger className="h-9 w-[9.5rem] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("common.all")}</SelectItem>
          {notificationTypes.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`notificationType.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={channel}
        onValueChange={(value) => {
          setChannel(value as NotificationChannel | "all");
          setPage(1);
        }}
      >
        <SelectTrigger className="h-9 w-[7.5rem] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("common.all")}</SelectItem>
          {channels.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`notificationChannel.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={state}
        onValueChange={(value) => {
          setState(value as NotificationState | "all");
          setPage(1);
        }}
      >
        <SelectTrigger className="h-9 w-[7.5rem] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("common.all")}</SelectItem>
          {states.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`notificationState.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DateInput
        className="h-9 w-[9.5rem] shrink-0"
        value={from}
        onChange={(value) => {
          setFrom(value);
          setPage(1);
        }}
        aria-label={t("common.from")}
      />
      <DateInput
        className="h-9 w-[9.5rem] shrink-0"
        value={to}
        onChange={(value) => {
          setTo(value);
          setPage(1);
        }}
        aria-label={t("common.to")}
      />
      <Button
        size="sm"
        variant="outline"
        className="ms-auto h-9 shrink-0"
        disabled={!canExport || !notifications.data?.items.length}
        onClick={() =>
          exportRecordsToCsv(
            (notifications.data?.items ?? []).map((item) => ({
              tenant: item.tenant?.name,
              type: item.type,
              channel: item.channel,
              locale: item.locale,
              template: item.template_code,
              state: item.state,
              scheduled_at: item.scheduled_at,
              sent_at: item.sent_at,
              provider: item.provider,
              provider_message_id: item.provider_message_id,
              failure_reason: item.failure_reason,
              retry_count: item.retry_count,
            })),
            "notification-pool.csv",
          )
        }
      >
        <Download className="size-4" />
        {t("notifications.export")}
      </Button>
    </div>
  );
}
