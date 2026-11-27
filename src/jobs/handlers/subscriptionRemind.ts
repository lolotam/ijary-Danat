import { companyClient } from "@/company/companyClient.server";
import {
  companyCalendarDate,
  daysBetweenDates,
  SUBSCRIPTION_OVERDUE_MARK,
  SUBSCRIPTION_REMINDER_MARKS,
  type JobPayload,
} from "@/jobs/catalog";
import { writePlatformAudit } from "@/platform/audit";
import {
  platformHasSubscriptionReminder,
  type CompanySubscriptionRow,
} from "@/platform/subscriptions";
import type { JobHandler } from "@/worker/runJob";

/** ما يُسجَّل للعلامة الواحدة بعد تشغيل المهمة. */
export interface SubscriptionRemindResult {
  companyId: string;
  subscriptionId: string;
  renewalDate: string;
  offsetDays: number;
  daysLeft: number;
  overdue: boolean;
  reminded: boolean;
  skipped?: "stale_mark" | "already_reminded";
}

/**
 * يبني معالج `subscription.remind`: يسجّل إنذاراً واحداً لكل علامة تجديد.
 *
 * The payload names one mark because the fan-out files one job per mark with a
 * dedupe key of company + renewal date + offset. The handler re-derives the day
 * count from the clock so a job that survived a renewal-date change does not
 * warn on a stale mark, and checks the audit log so a manual re-run with a new
 * job id cannot warn twice on the same day.
 */
export function createSubscriptionRemindHandler(now: () => Date = () => new Date()): JobHandler {
  return async (ctx) => {
    const payload = ctx.payload as JobPayload<"subscription.remind">;
    const subscription = await loadCurrentSubscription(
      companyClient(ctx.companyId),
      ctx.companyId,
      payload.renewalDate,
    );
    if (!subscription) {
      throw new Error(
        `subscription.remind: no current subscription for ${ctx.companyId} at ${payload.renewalDate}`,
      );
    }

    const daysLeft = daysBetweenDates(companyCalendarDate(now()), payload.renewalDate);
    const base = {
      companyId: ctx.companyId,
      subscriptionId: subscription.id,
      renewalDate: payload.renewalDate,
      offsetDays: payload.offsetDays,
      daysLeft,
      overdue: daysLeft < 0,
    };
    if (!markStillDue(daysLeft, payload.offsetDays)) {
      return { ...base, reminded: false, skipped: "stale_mark" } satisfies SubscriptionRemindResult;
    }

    const mark = {
      companyId: base.companyId,
      subscriptionId: subscription.id,
      renewalDate: payload.renewalDate,
      offsetDays: payload.offsetDays,
    };
    if (await platformHasSubscriptionReminder(mark)) {
      return {
        ...base,
        reminded: false,
        skipped: "already_reminded",
      } satisfies SubscriptionRemindResult;
    }

    await writePlatformAudit({
      action: "subscription.remind",
      entity: "company_subscription",
      entityId: subscription.id,
      companyId: ctx.companyId,
      after: {
        planName: subscription.plan_name,
        renewalDate: payload.renewalDate,
        offsetDays: payload.offsetDays,
        daysLeft,
        overdue: base.overdue,
      },
    });
    return { ...base, reminded: true } satisfies SubscriptionRemindResult;
  };
}

/**
 * يقرأ الاشتراك الحالي للشركة والذي يوافق تاريخ التجديد المطلوب.
 *
 * The company client carries the company claim, so RLS restricts the read to
 * this company's current row — the same restriction the renewal banner uses.
 */
async function loadCurrentSubscription(
  db: ReturnType<typeof companyClient>,
  companyId: string,
  renewalDate: string,
): Promise<CompanySubscriptionRow | null> {
  const { data, error } = await db
    .from("company_subscriptions")
    .select(
      "id, company_id, plan_name, price, period_start, renewal_date, status, note, recorded_by, created_at",
    )
    .eq("company_id", companyId)
    .eq("renewal_date", renewalDate)
    .order("period_start", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`company_subscriptions lookup for ${companyId} failed: ${error.message}`);
  }
  return (data ?? null) as CompanySubscriptionRow | null;
}

/**
 * يتحقق من أن اليوم المحسوب ما زال يطابق العلامة التي تحملها المهمة.
 */
function markStillDue(daysLeft: number, offsetDays: number): boolean {
  if (offsetDays === SUBSCRIPTION_OVERDUE_MARK) return daysLeft < 0;
  return (
    (SUBSCRIPTION_REMINDER_MARKS as readonly number[]).includes(offsetDays) &&
    daysLeft === offsetDays
  );
}
