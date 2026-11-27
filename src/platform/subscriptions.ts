import { z } from "zod";

import {
  companyCalendarDate,
  daysBetweenDates,
  SUBSCRIPTION_OVERDUE_MARK,
  SUBSCRIPTION_REMINDER_MARKS,
} from "@/jobs/catalog";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/database.types";

import { writePlatformAudit } from "./audit";
import { requirePlatformAdmin } from "./requirePlatformAdmin.server";

/** الحالات المسموحة لسجل الاشتراك؛ المتأخر يُشتقّ ولا يُكتب تلقائياً. */
export const SUBSCRIPTION_STATUSES = ["trial", "active", "overdue", "cancelled"] as const;
export type CompanySubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** سطر اشتراك واحد كما يقرأه المشرف العام. */
export interface CompanySubscriptionRow {
  id: string;
  company_id: string;
  plan_name: string;
  price: number;
  period_start: string;
  renewal_date: string;
  status: CompanySubscriptionStatus;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
}

/** مدخل تسجيل اشتراك جديد؛ التجديد يُسجَّل بصفّ جديد لا بتعديل القديم. */
export interface RecordSubscriptionInput {
  companyId: string;
  planName: string;
  price: number;
  periodStart: string;
  renewalDate: string;
  status: CompanySubscriptionStatus;
  note?: string | null;
}

const recordSchema = z
  .object({
    companyId: z.string().uuid(),
    planName: z.string().trim().min(1).max(120),
    price: z.number().finite().nonnegative().max(99_999_999_999.999),
    periodStart: z.string().date(),
    renewalDate: z.string().date(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    note: z.string().trim().max(1000).nullish(),
  })
  .refine((input) => input.renewalDate >= input.periodStart, {
    path: ["renewalDate"],
    message: "renewalDate must not precede periodStart",
  });

/** علامة تجديد واحدة مستحقة لشركة ما. */
export interface SubscriptionReminder {
  companyId: string;
  renewalDate: string;
  offsetDays: number;
}

/** ما يكفي للتعرف على علامة تذكير واحدة في سجل المنصة. */
interface ReminderMark {
  companyId: string;
  subscriptionId: string;
  renewalDate: string;
  offsetDays: number;
}

/**
 * يسجّل اشتراكاً جديداً لشركة ويكتب سطر تدقيق واحداً باسم المشرف الذي سجّله.
 *
 * The table is append-only: a renewal is a fresh row, so the history survives
 * even when a plan changes. The audit row is written only after the insert
 * succeeds — an action that was never stored must not look audited (SC-015).
 * The recorder is the verified caller from `requirePlatformAdmin()`, never an
 * argument, so the audit row cannot name someone else.
 */
export async function platformRecordSubscription(
  input: RecordSubscriptionInput,
): Promise<CompanySubscriptionRow> {
  const { userId: actorId } = await requirePlatformAdmin();
  const data = recordSchema.parse(input);

  const { data: inserted, error } = await supabaseAdmin
    .from("company_subscriptions")
    .insert({
      company_id: data.companyId,
      plan_name: data.planName,
      price: data.price,
      period_start: data.periodStart,
      renewal_date: data.renewalDate,
      status: data.status,
      note: data.note ?? null,
      recorded_by: actorId,
    })
    .select("*")
    .single();
  if (error) throw new Error(`company_subscriptions insert failed: ${error.message}`);

  const row = inserted as CompanySubscriptionRow;
  await writePlatformAudit({
    action: "subscription.record",
    entity: "company_subscription",
    entityId: row.id,
    companyId: row.company_id,
    actorId,
    after: {
      planName: row.plan_name,
      price: row.price,
      periodStart: row.period_start,
      renewalDate: row.renewal_date,
      status: row.status,
    },
  });
  return row;
}

/**
 * يُعيد كل سجلات اشتراك شركة واحدة، من الأحدث فترةً إلى الأقدم.
 */
export async function platformListSubscriptions(
  companyId: string,
): Promise<CompanySubscriptionRow[]> {
  await requirePlatformAdmin();
  const { data, error } = await supabaseAdmin
    .from("company_subscriptions")
    .select("*")
    .eq("company_id", companyId)
    .order("period_start", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(`company_subscriptions lookup failed: ${error.message}`);
  return (data ?? []) as CompanySubscriptionRow[];
}

/**
 * يجمع علامات التجديد المستحقة لكل شركة في هذا اليوم، من سجل الاشتراكات.
 *
 * No platform-admin guard here: this runs inside the worker's scheduler, which
 * has no caller token. The rows are platform-owned and the fan-out consumes
 * them only to file jobs under each company's own id.
 */
export async function platformDueSubscriptionReminders(at: Date): Promise<SubscriptionReminder[]> {
  const { data, error } = await supabaseAdmin
    .from("company_subscriptions")
    .select("company_id, period_start, renewal_date, status")
    .order("period_start", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`company_subscriptions reminder lookup failed: ${error.message}`);
  }

  const today = companyCalendarDate(at);
  const seen = new Set<string>();
  const reminders: SubscriptionReminder[] = [];
  for (const row of (data ?? []) as Array<{
    company_id: string;
    renewal_date: string;
    status: string;
  }>) {
    if (seen.has(row.company_id)) continue;
    seen.add(row.company_id);
    if (row.status === "cancelled") continue;

    const daysLeft = daysBetweenDates(today, row.renewal_date);
    const mark =
      (SUBSCRIPTION_REMINDER_MARKS as readonly number[]).find((offset) => offset === daysLeft) ??
      (daysLeft < 0 ? SUBSCRIPTION_OVERDUE_MARK : null);
    if (mark === null) continue;
    reminders.push({ companyId: row.company_id, renewalDate: row.renewal_date, offsetDays: mark });
  }
  return reminders;
}

/**
 * يخبر عمال التذكير إن كانت علامة هذا التجديد قد سُجَّل من قبل.
 *
 * The platform audit log is the durable record of warnings shown to the super
 * admin, so checking it here makes a repeated run of the same mark a no-op.
 */
export async function platformHasSubscriptionReminder(mark: ReminderMark): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("platform_audit_log")
    .select("after")
    .eq("action", "subscription.remind")
    .eq("company_id", mark.companyId)
    .eq("entity_id", mark.subscriptionId);
  if (error) throw new Error(`platform_audit_log reminder lookup failed: ${error.message}`);

  return (data ?? []).some((row) => isReminderMark(row.after as Json, mark));
}

/**
 * يتحقق من أن حمولة سطر التدقيق تحمل تاريخ التجديد والعلامة نفسهما.
 */
function isReminderMark(after: Json, mark: ReminderMark): boolean {
  if (!after || typeof after !== "object" || Array.isArray(after)) return false;
  const fields = after as Record<string, unknown>;
  return fields.renewalDate === mark.renewalDate && fields.offsetDays === mark.offsetDays;
}
