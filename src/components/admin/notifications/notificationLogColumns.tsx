import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import type { NotificationWithRelations } from "@/hooks/useNotifications";
import type { NotificationState } from "@/integrations/supabase/database.types";
import { splitEmailAddresses } from "@/lib/addressList";
import { attachmentMissingCodes } from "@/lib/notificationAttachmentMissing";

/** واصف عمود واحد في سجل الإشعارات — مصدر مشترك للجدول والبطاقات. */
export interface NotificationLogColumn {
  key: string;
  label: string;
  /** يرسم محتوى الخلية/البطاقة لهذا العمود. */
  render: (item: NotificationWithRelations) => ReactNode;
  /** classes للخلية في الجدول فقط؛ البطاقة تتجاهلها. */
  cellClassName?: string;
  /**
   * تلميح العنوان الكامل للخلايا المقطوعة (`max-w-* truncate`).
   * بدونها القيمة الكاملة تصبح غير قابلة للوصول — وهذا هو عيب البيانات
   * الذي صُمّم هذا الواصف لمنعه.
   */
  title?: (item: NotificationWithRelations) => string | undefined;
}

type Translate = (key: string) => string;

type StateVariant = (state: NotificationState) => "default" | "destructive" | "secondary";
type StateBadgeClass = (state: NotificationState) => string;

/**
 * أعمدة سجل الإشعارات: واصف واحد لكل حقل، بالترتيب المعروض.
 *
 * مصدر الحقيقة الوحيد لكل من جدول سطح المكتب وبطاقات الجوال (useIsMobile).
 * قائمتان مكتوبتان يدوياً كانتا ستتباعدان؛ بطاقة تفتقد `failure` هي العيب
 * الذي يمنع هذا الملف.
 */
export function notificationLogColumns(
  t: Translate,
  stateVariant: StateVariant,
  stateBadgeClass: StateBadgeClass,
): NotificationLogColumn[] {
  return [
    {
      key: "tenant",
      label: t("notifications.tenant"),
      render: (item) => (
        <>
          <span className="whitespace-nowrap font-medium">{item.tenant?.name ?? "—"}</span>
          {item.tenant && !item.tenant.reminders_enabled && (
            <Badge variant="outline" className="ms-2">
              {t("notifications.remindersOff")}
            </Badge>
          )}
        </>
      ),
    },
    {
      key: "audience",
      label: t("notifications.audience"),
      render: (item) =>
        item.audience === "admin"
          ? t("notifications.audienceAdmin")
          : item.audience === "tenant"
            ? t("notifications.audienceTenant")
            : (item.audience ?? "—"),
    },
    {
      key: "to",
      label: t("notifications.to"),
      cellClassName: "max-w-48 font-mono text-xs",
      title: (item) => item.recipient_address ?? undefined,
      render: (item) => {
        if (!item.recipient_address) return "—";
        const addresses = splitEmailAddresses(item.recipient_address);
        if (addresses.length <= 1) return <LtrText>{item.recipient_address}</LtrText>;
        return (
          <ul className="space-y-0.5">
            {addresses.map((address) => (
              <li key={address.toLowerCase()} className="break-all">
                <LtrText>{address}</LtrText>
              </li>
            ))}
          </ul>
        );
      },
    },
    {
      key: "from",
      label: t("notifications.from"),
      cellClassName: "max-w-36 truncate font-mono text-xs",
      title: (item) => item.sender_address ?? undefined,
      render: (item) => item.sender_address ?? "—",
    },
    {
      key: "type",
      label: t("common.type"),
      render: (item) => t(`notificationType.${item.type}`),
    },
    {
      key: "related",
      label: t("notifications.related"),
      cellClassName: "font-mono text-xs",
      render: (item) => item.invoice?.code ?? item.contract?.code ?? "—",
    },
    {
      key: "language",
      label: t("notifications.language"),
      render: (item) => item.locale.toUpperCase(),
    },
    {
      key: "channel",
      label: t("notifications.channel"),
      render: (item) => t(`notificationChannel.${item.channel}`),
    },
    {
      key: "template",
      label: t("notifications.template"),
      cellClassName: "font-mono text-xs",
      render: (item) => item.template_code ?? "—",
    },
    {
      key: "scheduledAt",
      label: t("notifications.scheduledAt"),
      cellClassName: "whitespace-nowrap text-xs",
      render: (item) =>
        item.scheduled_at ? new Date(item.scheduled_at).toLocaleString("en-GB") : "—",
    },
    {
      key: "sentAt",
      label: t("notifications.sentAt"),
      cellClassName: "whitespace-nowrap text-xs",
      render: (item) => (item.sent_at ? new Date(item.sent_at).toLocaleString("en-GB") : "—"),
    },
    {
      key: "provider",
      label: t("notifications.provider"),
      render: (item) => (item.provider ? t(`notificationProvider.${item.provider}`) : "—"),
    },
    {
      key: "providerId",
      label: t("notifications.providerId"),
      cellClassName: "max-w-32 truncate font-mono text-xs",
      title: (item) => item.provider_message_id ?? undefined,
      render: (item) => item.provider_message_id ?? "—",
    },
    {
      key: "status",
      label: t("common.status"),
      render: (item) => {
        // Beside the state, not instead of it: the message WAS delivered, so
        // "sent" stays true — this says what it was delivered without.
        const missing = attachmentMissingCodes(item.payload);
        return (
          <>
            <Badge variant={stateVariant(item.state)} className={stateBadgeClass(item.state)}>
              {t(`notificationState.${item.state}`)}
            </Badge>
            {missing.length > 0 && (
              <Badge variant="destructive" className="ms-2" title={missing.join(", ")}>
                {t("notifications.pdfMissing")}
              </Badge>
            )}
          </>
        );
      },
    },
    {
      key: "failure",
      label: t("notifications.failure"),
      cellClassName: "max-w-52 truncate text-xs text-destructive",
      title: (item) => item.failure_reason ?? undefined,
      render: (item) => item.failure_reason ?? "—",
    },
    {
      key: "retries",
      label: t("notifications.retries"),
      cellClassName: "tabular-nums",
      render: (item) => item.retry_count,
    },
  ];
}
