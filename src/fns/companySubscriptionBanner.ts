import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { companyCalendarDate, daysBetweenDates } from "@/jobs/catalog";
import type { CompanySubscriptionRow } from "@/platform/subscriptions";

/** ما يحتاجه شريط التجديد في لوحة الشركة. */
export interface CompanySubscriptionBannerData {
  daysLeft: number;
  endsOn: string;
  overdue: boolean;
}

/**
 * يحوّل اشتراك الشركة إلى بيانات الشريط، أو null إن لم يكن هناك اشتراك.
 *
 * The function returns the raw day count even when it is large: the banner
 * decides when to appear, so a future change to the 14-day rule touches one
 * component rather than the server contract.
 */
export function subscriptionBannerFor(
  subscription: CompanySubscriptionRow | null | undefined,
  at: Date,
): CompanySubscriptionBannerData | null {
  if (!subscription) return null;
  const daysLeft = daysBetweenDates(companyCalendarDate(at), subscription.renewal_date);
  return {
    daysLeft,
    endsOn: subscription.renewal_date,
    overdue: daysLeft < 0,
  };
}

/**
 * يقرأ اشتراك الشركة الحالي بصلاحية الموظف المقيّدة بـ RLS، لا بصلاحية المنصة.
 *
 * The select is capped at one row and ordered by `period_start` because the
 * policy lets staff see only the current row; ordering makes that contract
 * explicit even if the policy widens later.
 */
export const companySubscriptionBanner = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CompanySubscriptionBannerData | null> => {
    const { data, error } = await context.supabase
      .from("company_subscriptions")
      .select(
        "id, company_id, plan_name, price, period_start, renewal_date, status, note, recorded_by, created_at",
      )
      .order("period_start", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`company_subscriptions lookup failed: ${error.message}`);
    }
    return subscriptionBannerFor(data as CompanySubscriptionRow | null, new Date());
  });
