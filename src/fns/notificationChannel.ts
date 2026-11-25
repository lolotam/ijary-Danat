import type { Json, NotificationProvider, Tables } from "@/integrations/supabase/database.types";
import type { EmailAttachment } from "@/lib/providers/types";

/**
 * عائق يوقف قناةً واحدة أثناء الإرسال: «تخطٍّ» حين لا ينطبق تذكير المستأجر
 * أو تكون القناة غير مهيّأة (لا مستلم، لا مزوّد مُفعّل)، و«فشل» حين تعثّرت
 * محاولة إرسال حقيقية يستحق إعادة محاولةٍ عليها.
 *
 * Audit M6: the terminal state must be decided by this explicit kind, never
 * by matching the English prose of the message — a reworded sentence silently
 * flipped `skipped` to `failed`, and the drain job retried configuration
 * problems no retry can fix.
 */
export type NotificationIssue = { kind: "skip" | "failure"; message: string };

/** المزوّدون المفعّلون، مفهرسين باسم المزوّد. */
export type EnabledConfigs = Map<NotificationProvider, Tables<"provider_configs">>;

/**
 * نتيجة قناة إرسال واحدة (بريد أو واتساب) كما تعيدها لدالة الإرسال الرئيسية.
 *
 * `provider` is set only when the channel actually sent. `senderAddress` is the
 * running sender value after this channel — the caller threads it from the
 * email channel into the WhatsApp one, which is what `dispatchNotificationRecord`
 * did with a single mutable variable before the split (audit M9).
 */
export interface ChannelOutcome {
  messageIds: string[];
  issues: NotificationIssue[];
  provider: NotificationProvider | null;
  senderAddress: string | null;
}

/** ما تحتاجه كل قناة من الإشعار الجاري إرساله. */
export interface ChannelInput {
  notification: Tables<"notifications">;
  tenant: Tables<"tenants"> | null;
  configs: EnabledConfigs;
  attachments: EmailAttachment[];
  senderAddress: string | null;
}

/**
 * أنواع الإشعارات الاستباقية التي يحكمها مفتاح تذكيرات المستأجر.
 *
 * Proactive reminders only — credentials and payment receipts always attempt
 * send. Shared by the email and WhatsApp channels: the tenant's reminders
 * switch is channel-agnostic, so the same type list gates both.
 */
const PROACTIVE_REMINDER_TYPES = new Set(["due_reminder", "overdue_reminder", "contract_expiry"]);

/**
 * هل أوقف المستأجر التذكيرات الاستباقية لهذا الإشعار؟
 *
 * Tenant audience only: admin alert rows carry the same tenant_id and type,
 * and an opted-out tenant must not silence the office. Written once here —
 * both channels carried their own copy of this four-part condition, which is
 * how one of them would have drifted first.
 */
export function tenantOptedOut(
  notification: Tables<"notifications">,
  tenant: Tables<"tenants"> | null,
): boolean {
  return Boolean(
    notification.audience === "tenant" &&
    PROACTIVE_REMINDER_TYPES.has(notification.type) &&
    tenant &&
    !tenant.reminders_enabled,
  );
}

/** يقرأ مصفوفة نصوص غير فارغة من حمل JSON، أو مصفوفة فارغة. */
export function stringArray(value: Json, key: string): string[] {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  const item = value[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}
